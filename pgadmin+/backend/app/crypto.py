import base64
import hashlib

from cryptography.fernet import Fernet

from app.config import settings
from app.meta.db import SessionLocal
from app.meta.models import AppSetting

_fernet: Fernet | None = None


def _to_fernet_key(secret: str) -> bytes:
    return base64.urlsafe_b64encode(hashlib.sha256(secret.encode()).digest())


async def init_crypto() -> None:
    """Use APP_SECRET_KEY if set, otherwise a key generated once and stored in the meta DB."""
    global _fernet
    secret = settings.app_secret_key.strip()
    if not secret:
        async with SessionLocal() as session:
            row = await session.get(AppSetting, "secret_key")
            if row is None:
                row = AppSetting(key="secret_key", value=Fernet.generate_key().decode())
                session.add(row)
                await session.commit()
            secret = row.value
    _fernet = Fernet(_to_fernet_key(secret))


def encrypt(value: str) -> str:
    assert _fernet is not None, "crypto not initialised"
    return _fernet.encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    assert _fernet is not None, "crypto not initialised"
    return _fernet.decrypt(value.encode()).decode()
