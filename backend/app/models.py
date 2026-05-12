from datetime import datetime

from sqlalchemy import DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    original_filename: Mapped[str] = mapped_column(String(255))
    status: Mapped[str] = mapped_column(String(32), default="uploaded", index=True)
    upload_path: Mapped[str] = mapped_column(Text)
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    transcript_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_status: Mapped[str] = mapped_column(String(32), default="not_started", index=True)
    summary_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    summary_preset: Mapped[str | None] = mapped_column(String(64), nullable=True)
    processing_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    summary_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    cleanup_status: Mapped[str] = mapped_column(String(32), default="not_started", index=True)
    cleanup_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    cleanup_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
