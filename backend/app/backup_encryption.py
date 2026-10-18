"""Native password-protected ZIP exports, with legacy .enc read support."""

import copy
import io
import os
import secrets
import select
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
import zlib
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from .domain import DomainError


class LegacyBackupEncryption:
    # Fixed KDF parameters are part of v1, never read from an untrusted file.
    PREFIX = b"YOUSHU-BACKUP\x00"
    MAGIC = PREFIX + b"\x01"
    SALT_SIZE = 16
    NONCE_SIZE = 12
    HEADER_SIZE = len(MAGIC) + SALT_SIZE + NONCE_SIZE
    MAX_SIZE = 64 * 1024 * 1024

    @staticmethod
    def password(value):
        if not isinstance(value, str) or len(value) > 256:
            raise DomainError("备份密码最多 256 个字符")
        try:
            return value.encode("utf-8")
        except UnicodeEncodeError:
            raise DomainError("备份密码含有无效字符") from None

    @staticmethod
    def key(password, salt):
        return Scrypt(salt=salt, length=32, n=2**15, r=8, p=1).derive(password)

    @classmethod
    def encrypted(cls, content):
        return content.startswith(cls.PREFIX)

    @classmethod
    def seal(cls, content, password=""):
        secret = cls.password(password)
        if not secret:
            return content
        salt = secrets.token_bytes(cls.SALT_SIZE)
        nonce = secrets.token_bytes(cls.NONCE_SIZE)
        header = cls.MAGIC + salt + nonce
        return header + AESGCM(cls.key(secret, salt)).encrypt(nonce, content, header)

    @classmethod
    def open(cls, content, password=""):
        if not content or len(content) > cls.MAX_SIZE:
            raise DomainError("请选择不超过 64 MB 的账本备份")
        secret = cls.password(password)
        if not cls.encrypted(content):
            return content
        if not content.startswith(cls.MAGIC):
            raise DomainError("加密备份版本不受支持，请使用对应版本程序恢复")
        if len(content) < cls.HEADER_SIZE + 16:
            raise DomainError("加密备份不完整，文件可能已损坏")
        if not secret:
            raise DomainError("这是加密备份，请输入下载时设置的密码")
        salt = content[len(cls.MAGIC) : len(cls.MAGIC) + cls.SALT_SIZE]
        nonce = content[len(cls.MAGIC) + cls.SALT_SIZE : cls.HEADER_SIZE]
        try:
            return AESGCM(cls.key(secret, salt)).decrypt(
                nonce, content[cls.HEADER_SIZE :], content[: cls.HEADER_SIZE]
            )
        except InvalidTag:
            raise DomainError("密码不正确或备份文件已损坏，请检查后重试") from None


class NativeZipEncryption:
    @staticmethod
    def seal(content, password):
        # The system tool reads its password from a private terminal, never
        # from command arguments, shell interpolation, or a password file.
        import pty
        import termios

        tool = shutil.which("zipcloak")
        if not tool:
            raise DomainError("未找到系统 ZIP 加密工具 zipcloak")
        if len(password) > 80 or any(byte < 32 or byte == 127 for byte in password):
            raise DomainError("ZIP 密码过长或含控制字符，请缩短后重试")
        with tempfile.TemporaryDirectory(prefix="ledger-zip-") as folder:
            path = Path(folder) / "backup.zip"
            path.write_bytes(content)
            path.chmod(0o600)
            master, slave = pty.openpty()
            process = None
            try:
                attrs = termios.tcgetattr(slave)
                attrs[3] |= termios.ECHO
                termios.tcsetattr(slave, termios.TCSANOW, attrs)
                # A fresh interpreter sets up the controlling terminal. Avoid
                # preexec_fn, which is unsafe in the threaded web service.
                worker = (
                    "import os,sys,fcntl,termios; os.setsid(); "
                    "fcntl.ioctl(0,termios.TIOCSCTTY,0); "
                    "os.execv(sys.argv[1],sys.argv[1:])"
                )
                environment = dict(os.environ, LC_ALL="C")
                for key in ("ZIP", "ZIPOPT", "ACCOUNT-BILL-PWD"):
                    environment.pop(key, None)
                process = subprocess.Popen(
                    [sys.executable, "-c", worker, tool, path.name],
                    cwd=folder,
                    stdin=slave,
                    stdout=slave,
                    stderr=slave,
                    env=environment,
                )
                os.close(slave)
                slave = None
                buffer, prompts = b"", 0
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            chunk = os.read(master, 4096)
                        except OSError:
                            break
                        if not chunk:
                            break
                        buffer = (buffer + chunk)[-8192:]
                        if b"password:" in buffer.lower():
                            if prompts >= 2:
                                raise DomainError("系统 ZIP 未接受此密码，请调整后重试")
                            # getpass disables echo and flushes pending input;
                            # wait for that transition so it cannot discard an
                            # early response immediately after the prompt.
                            ready = time.monotonic() + 2
                            while termios.tcgetattr(master)[3] & termios.ECHO:
                                if time.monotonic() > ready:
                                    raise DomainError("系统 ZIP 密码输入未就绪，请重试")
                                time.sleep(0.005)
                            os.write(master, password + b"\n")
                            prompts += 1
                            buffer = b""
                    elif process.poll() is not None:
                        break
                if process.poll() is None:
                    try:
                        process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        raise DomainError("ZIP 加密超时，请重试") from None
                if process.returncode != 0 or prompts != 2:
                    raise DomainError("系统 ZIP 加密失败，请检查密码与运行环境")
                result = path.read_bytes()
                with zipfile.ZipFile(io.BytesIO(result)) as archive:
                    if not archive.infolist() or not all(
                        item.flag_bits & 1 for item in archive.infolist()
                    ):
                        raise DomainError("ZIP 密码保护未生效，已停止导出")
                    # Detect passwords truncated or interpreted by the native tool.
                    for item in archive.infolist():
                        archive.read(item, pwd=password)
                return result
            except (OSError, RuntimeError, zipfile.BadZipFile):
                raise DomainError("系统 ZIP 加密失败，请检查密码与运行环境") from None
            finally:
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait()
                os.close(master)
                if slave is not None:
                    os.close(slave)


class BackupEncryption(LegacyBackupEncryption):
    @classmethod
    def encrypted(cls, content):
        if LegacyBackupEncryption.encrypted(content):
            return True
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                return any(item.flag_bits & 1 for item in archive.infolist())
        except (OSError, zipfile.BadZipFile):
            return False

    @classmethod
    def seal(cls, content, password=""):
        secret = cls.password(password)
        return NativeZipEncryption.seal(content, secret) if secret else content

    @classmethod
    def open(cls, content, password=""):
        if not content or len(content) > cls.MAX_SIZE:
            raise DomainError("请选择不超过 64 MB 的账本备份")
        if LegacyBackupEncryption.encrypted(content):
            return LegacyBackupEncryption.open(content, password)
        secret = cls.password(password)
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                files = archive.infolist()
                if not any(item.flag_bits & 1 for item in files):
                    return content
                if not secret:
                    raise DomainError("这是加密 ZIP，请输入下载时设置的密码")
                if len(files) != 2 or {item.filename for item in files} != {
                    "manifest.json",
                    "data.json",
                }:
                    raise DomainError("备份文件结构错误，应包含清单和业务数据")
                if any(
                    item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                    for item in files
                ):
                    raise DomainError("备份使用了不支持的 ZIP 压缩方式")
                if (
                    archive.getinfo("manifest.json").file_size > 65536
                    or archive.getinfo("data.json").file_size > 256 * 1024 * 1024
                ):
                    raise DomainError("备份解压后的数据超过限制")
                output = io.BytesIO()
                with zipfile.ZipFile(output, "w") as plain:
                    for item in files:
                        info = copy.copy(item)
                        info.flag_bits &= ~1
                        plain.writestr(info, archive.read(item, pwd=secret))
                return output.getvalue()
        except DomainError:
            raise
        except (
            RuntimeError,
            OSError,
            ValueError,
            NotImplementedError,
            zipfile.BadZipFile,
            zlib.error,
        ):
            raise DomainError("密码不正确或 ZIP 文件已损坏，请检查后重试") from None
