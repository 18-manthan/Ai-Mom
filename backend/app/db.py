from sqlalchemy import create_engine
from sqlalchemy import text
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings


connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    from . import models

    Base.metadata.create_all(bind=engine)
    _ensure_sqlite_columns()


def _ensure_sqlite_columns() -> None:
    if not settings.database_url.startswith("sqlite"):
        return

    with engine.begin() as connection:
        columns = {
            row[1]
            for row in connection.execute(text("PRAGMA table_info(meetings)")).fetchall()
        }
        if "summary_status" not in columns:
            connection.execute(
                text("ALTER TABLE meetings ADD COLUMN summary_status VARCHAR(32) DEFAULT 'not_started'")
            )
        if "summary_error" not in columns:
            connection.execute(text("ALTER TABLE meetings ADD COLUMN summary_error TEXT"))
        if "processing_seconds" not in columns:
            connection.execute(text("ALTER TABLE meetings ADD COLUMN processing_seconds REAL"))
        if "summary_seconds" not in columns:
            connection.execute(text("ALTER TABLE meetings ADD COLUMN summary_seconds REAL"))
        if "summary_preset" not in columns:
            connection.execute(text("ALTER TABLE meetings ADD COLUMN summary_preset VARCHAR(64)"))
        if "generated_notes" not in columns:
            connection.execute(text("ALTER TABLE meetings ADD COLUMN generated_notes TEXT"))
        if "cleanup_status" not in columns:
            connection.execute(
                text("ALTER TABLE meetings ADD COLUMN cleanup_status VARCHAR(32) DEFAULT 'not_started'")
            )
        if "cleanup_error" not in columns:
            connection.execute(text("ALTER TABLE meetings ADD COLUMN cleanup_error TEXT"))
        if "cleanup_seconds" not in columns:
            connection.execute(text("ALTER TABLE meetings ADD COLUMN cleanup_seconds REAL"))


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
