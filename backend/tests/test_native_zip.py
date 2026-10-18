"""Focused format/password checks without ledger import or restoration."""

import io
import zipfile
import pytest
from app.backup_encryption import BackupEncryption, LegacyBackupEncryption
from app.domain import DomainError


def sample():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", b'{"sample":true}')
        archive.writestr("data.json", b'{"tables":{}}')
    return output.getvalue()


def test_native_zip_members_require_password_and_roundtrip():
    plain, password = sample(), "  原生 ZIP synthetic 🔐  "
    protected = BackupEncryption.seal(plain, password)
    assert protected.startswith(b"PK") and zipfile.is_zipfile(io.BytesIO(protected))
    assert BackupEncryption.encrypted(protected)
    with zipfile.ZipFile(io.BytesIO(protected)) as archive:
        assert set(archive.namelist()) == {"manifest.json", "data.json"}
        assert all(item.flag_bits & 1 for item in archive.infolist())
        for name in archive.namelist():
            with pytest.raises(RuntimeError):
                archive.read(name)
            with pytest.raises(RuntimeError):
                archive.read(name, pwd=b"wrong")
            assert archive.read(name, pwd=password.encode())
    assert BackupEncryption.open(protected, password) == plain
    for wrong in ("", "wrong"):
        with pytest.raises(DomainError):
            BackupEncryption.open(protected, wrong)
    with pytest.raises(DomainError):
        BackupEncryption.open(protected[:30], password)
    assert BackupEncryption.seal(plain, "") == plain
    assert not BackupEncryption.encrypted(plain)
    assert BackupEncryption.open(plain) == plain


def test_legacy_backups_remain_readable_and_native_rejects_control_passwords():
    plain = sample()
    legacy = LegacyBackupEncryption.seal(plain, "legacy-password")
    assert BackupEncryption.open(legacy, "legacy-password") == plain
    for password in ("x" * 81, "secret\npassword", "secret\x00password"):
        with pytest.raises(DomainError):
            BackupEncryption.seal(plain, password)
