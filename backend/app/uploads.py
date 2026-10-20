"""Bounded uploads are closed before CPU/database processing moves to a worker."""

from .domain import DomainError


async def read_upload(file, limit=10 * 1024 * 1024):
    try:
        content = await file.read(limit + 1)
        if len(content) > limit:
            raise DomainError("文件不能超过 10 MB")
        return content
    finally:
        await file.close()
