import json
import shutil
from pathlib import Path
from uuid import uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db, init_db
from .models import Meeting
from .services.audio import validate_media_file
from .services.live import append_live_segment, finish_live_meeting, start_live_meeting
from .services.processor import process_cleanup, process_meeting, process_summary


app = FastAPI(title="MOM AI Meeting Transcription")


class SummaryRequest(BaseModel):
    preset: str = "short"


class LiveMeetingStartRequest(BaseModel):
    title: str | None = None
    source: str = "google_meet"


class LiveSegmentRequest(BaseModel):
    text: str
    speaker: str = "Speaker"
    start: float | None = None
    end: float | None = None
    external_id: str | None = None
    source: str | None = None
    is_final: bool = True


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://meet.google.com",
    ],
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.transcript_dir.mkdir(parents=True, exist_ok=True)
    init_db()


def _meeting_payload(meeting: Meeting) -> dict:
    summary_status = meeting.summary_status or "not_started"
    if meeting.summary and summary_status == "not_started":
        summary_status = "completed"
    cleanup_status = meeting.cleanup_status or "not_started"

    return {
        "id": meeting.id,
        "original_filename": meeting.original_filename,
        "status": meeting.status,
        "summary": meeting.summary,
        "summary_status": summary_status,
        "summary_error": meeting.summary_error,
        "summary_preset": meeting.summary_preset,
        "processing_seconds": meeting.processing_seconds,
        "summary_seconds": meeting.summary_seconds,
        "cleanup_status": cleanup_status,
        "cleanup_error": meeting.cleanup_error,
        "cleanup_seconds": meeting.cleanup_seconds,
        "error": meeting.error,
        "created_at": meeting.created_at.isoformat(),
        "updated_at": meeting.updated_at.isoformat(),
    }


def _delete_file(path_value: str | None) -> None:
    if not path_value:
        return

    path = Path(path_value)
    allowed_roots = [
        settings.upload_dir.resolve(),
        settings.transcript_dir.resolve(),
    ]
    try:
        resolved = path.resolve()
    except FileNotFoundError:
        return

    if any(resolved == root or root in resolved.parents for root in allowed_roots):
        resolved.unlink(missing_ok=True)


def _load_transcript(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        transcript, _ = json.JSONDecoder().raw_decode(text)
        if isinstance(transcript, dict):
            path.write_text(json.dumps(transcript, indent=2), encoding="utf-8")
            return transcript
        raise


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/api/meetings")
def upload_meeting(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> dict:
    try:
        validate_media_file(file.filename or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    suffix = Path(file.filename or "").suffix.lower()
    safe_name = f"{uuid4().hex}{suffix}"
    upload_path = settings.upload_dir / safe_name
    with upload_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    meeting = Meeting(
        original_filename=file.filename or safe_name,
        status="uploaded",
        upload_path=str(upload_path),
    )
    db.add(meeting)
    db.commit()
    db.refresh(meeting)

    background_tasks.add_task(process_meeting, meeting.id)
    return _meeting_payload(meeting)


@app.get("/api/meetings")
def list_meetings(db: Session = Depends(get_db)) -> list[dict]:
    meetings = db.query(Meeting).order_by(Meeting.created_at.desc()).all()
    return [_meeting_payload(meeting) for meeting in meetings]


@app.post("/api/live-meetings")
def create_live_meeting(
    request: LiveMeetingStartRequest | None = None,
    db: Session = Depends(get_db),
) -> dict:
    meeting = start_live_meeting(
        db,
        title=request.title if request else None,
        source=request.source if request else "google_meet",
    )
    return _meeting_payload(meeting)


@app.post("/api/live-meetings/{meeting_id}/segments")
def add_live_segment(
    meeting_id: int,
    request: LiveSegmentRequest,
    db: Session = Depends(get_db),
) -> dict:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    try:
        segment = append_live_segment(db, meeting, request.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"meeting": _meeting_payload(meeting), "segment": segment}


@app.post("/api/live-meetings/{meeting_id}/finish")
def finish_live(
    meeting_id: int,
    db: Session = Depends(get_db),
) -> dict:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    try:
        meeting = finish_live_meeting(db, meeting)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return _meeting_payload(meeting)


@app.post("/api/meetings/{meeting_id}/summary")
def start_summary(
    meeting_id: int,
    background_tasks: BackgroundTasks,
    request: SummaryRequest | None = None,
    db: Session = Depends(get_db),
) -> dict:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.status != "completed":
        raise HTTPException(status_code=409, detail="Transcription is not completed yet")
    if meeting.summary_status == "processing":
        return _meeting_payload(meeting)

    meeting.summary_status = "queued"
    meeting.summary_error = None
    meeting.summary_preset = (request.preset if request else "short")
    db.commit()
    db.refresh(meeting)

    background_tasks.add_task(process_summary, meeting.id, meeting.summary_preset)
    return _meeting_payload(meeting)


@app.post("/api/meetings/{meeting_id}/cleanup")
def start_cleanup(
    meeting_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
) -> dict:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.status != "completed":
        raise HTTPException(status_code=409, detail="Transcription is not completed yet")
    if meeting.cleanup_status == "processing":
        return _meeting_payload(meeting)

    meeting.cleanup_status = "queued"
    meeting.cleanup_error = None
    db.commit()
    db.refresh(meeting)

    background_tasks.add_task(process_cleanup, meeting.id)
    return _meeting_payload(meeting)


@app.get("/api/meetings/{meeting_id}")
def get_meeting(meeting_id: int, db: Session = Depends(get_db)) -> dict:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")

    payload = _meeting_payload(meeting)
    payload["segments"] = []
    payload["cleaned_segments"] = []
    payload["language"] = None
    payload["language_probability"] = None

    if meeting.transcript_path:
        path = Path(meeting.transcript_path)
        if path.exists():
            transcript = _load_transcript(path)
            payload.update(
                {
                    "segments": transcript.get("segments", []),
                    "cleaned_segments": transcript.get("cleaned_segments", []),
                    "language": transcript.get("language"),
                    "language_probability": transcript.get("language_probability"),
                }
            )
    return payload


@app.delete("/api/meetings/{meeting_id}")
def delete_meeting(meeting_id: int, db: Session = Depends(get_db)) -> dict:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")

    _delete_file(meeting.upload_path)
    _delete_file(meeting.audio_path)
    _delete_file(meeting.transcript_path)

    db.delete(meeting)
    db.commit()
    return {"deleted": True, "id": meeting_id}
