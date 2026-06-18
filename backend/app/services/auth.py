import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import AuthSession, User


SESSION_DAYS = 14


def normalize_email(email: str) -> str:
    return email.strip().lower()


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 240_000)
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, salt, digest_hex = stored_hash.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 240_000)
    return hmac.compare_digest(digest.hex(), digest_hex)


def create_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(48)
    db.add(
        AuthSession(
            token=token,
            user_id=user.id,
            expires_at=datetime.utcnow() + timedelta(days=SESSION_DAYS),
        )
    )
    db.commit()
    return token


def user_payload(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "status": user.status,
        "created_at": user.created_at.isoformat(),
    }


def current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not settings.auth_enabled:
        return User(
            id=0,
            name="Manthan Chouhan",
            email="manthanchouhan2003@gmail.com",
            password_hash="",
            role="user",
            status="approved",
            created_at=datetime.utcnow(),
        )

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Login required")

    token = authorization.split(" ", 1)[1].strip()
    session = db.query(AuthSession).filter(AuthSession.token == token).first()
    if session is None or session.expires_at <= datetime.utcnow():
        raise HTTPException(status_code=401, detail="Session expired")

    user = db.get(User, session.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    if user.status != "approved":
        raise HTTPException(status_code=403, detail="Account is not approved yet")
    return user


def current_admin(user: User = Depends(current_user)) -> User:
    if user.role != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin access required")
    return user
