import os
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher
from pwdlib.hashers.bcrypt import BcryptHasher
from loguru import logger

import database
import config

# ── password hashing ──────────────────────

_pwd_hash = PasswordHash((Argon2Hasher(), BcryptHasher()))


def hash_password(password: str) -> str:
    return _pwd_hash.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return _pwd_hash.verify(plain, hashed)


def verify_and_update_password(plain: str, hashed: str) -> tuple[bool, str | None]:
    """Verify and return (valid, updated_hash) if password needs rehashing."""
    return _pwd_hash.verify_and_update(plain, hashed)


# ── JWT ───────────────────────────────────

ACCESS_EXPIRE_MINUTES = 15
REFRESH_EXPIRE_DAYS = 7
ALGORITHM = "HS256"


def _get_secret() -> str:
    key = os.environ.get("JWT_SECRET", "").strip()
    if not key:
        raise RuntimeError(
            "JWT_SECRET is not set. Run 'python generate_keys.py' to create one."
        )
    return key


def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_EXPIRE_MINUTES)
    payload = {"sub": user_id, "exp": expire, "type": "access"}
    return jwt.encode(payload, _get_secret(), algorithm=ALGORITHM)


def create_refresh_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_EXPIRE_DAYS)
    payload = {"sub": user_id, "exp": expire, "type": "refresh"}
    return jwt.encode(payload, _get_secret(), algorithm=ALGORITHM)


def decode_token(token: str, token_type: str = "access") -> dict:
    try:
        payload = jwt.decode(token, _get_secret(), algorithms=[ALGORITHM])
        if payload.get("type") != token_type:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token type",
            )
        if payload.get("sub") is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token",
            )
        return payload
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
        )


def decode_token_safe(token: str, token_type: str = "access") -> dict | None:
    """Decode without raising HTTPException (for query-param auth)."""
    try:
        payload = jwt.decode(token, _get_secret(), algorithms=[ALGORITHM])
        if payload.get("type") != token_type or payload.get("sub") is None:
            return None
        return payload
    except JWTError:
        return None


# ── FastAPI dependency ────────────────────

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header required",
        )
    payload = decode_token(credentials.credentials, "access")
    user = await database.app.get_user_by_id(payload["sub"])
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )
    return user
