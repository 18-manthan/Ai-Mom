import json
import re
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
from .services.chat import answer_meeting_question
from .services.live import append_live_segment, compact_live_segments, finish_live_meeting, start_live_meeting
from .services.processor import process_cleanup, process_meeting, process_summary


app = FastAPI(title="iMann AI Meeting Transcription")


class SummaryRequest(BaseModel):
    preset: str = "short"


class ChatRequest(BaseModel):
    question: str


class LiveMeetingStartRequest(BaseModel):
    title: str | None = None
    source: str = "google_meet"
    meeting_code: str | None = None
    source_url: str | None = None


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
        "https://teams.microsoft.com",
        "https://teams.cloud.microsoft",
        "https://teams.live.com",
    ],
    allow_origin_regex=r"(chrome-extension://.*|https://.*\.teams\.microsoft\.com|https://.*\.teams\.cloud\.microsoft|https://.*\.teams\.live\.com)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    settings.transcript_dir.mkdir(parents=True, exist_ok=True)
    init_db()


def _transcript_metadata(meeting: Meeting) -> dict:
    defaults = {
        "is_live": False,
        "source": None,
        "meeting_code": None,
        "source_url": None,
        "started_at": None,
        "finished_at": None,
        "segment_count": 0,
        "speakers": [],
    }
    if not meeting.transcript_path:
        return defaults

    path = Path(meeting.transcript_path)
    if not path.exists():
        return defaults

    try:
        transcript = _load_transcript(path)
    except (json.JSONDecodeError, OSError, ValueError):
        return defaults

    stored_speakers = transcript.get("speakers")
    if isinstance(stored_speakers, list):
        speakers = [
            speaker
            for speaker in (_clean_list_speaker(str(value)) for value in stored_speakers)
            if speaker and not _is_bad_list_speaker(speaker)
        ]
    else:
        speakers = []
    segments = transcript.get("cleaned_segments") or transcript.get("segments", [])
    if not speakers:
        speakers = _extract_speakers_for_list(segments)
    return {
        "is_live": bool(transcript.get("live", False)),
        "source": transcript.get("source"),
        "meeting_code": transcript.get("meeting_code"),
        "source_url": transcript.get("source_url"),
        "started_at": transcript.get("started_at"),
        "finished_at": transcript.get("finished_at"),
        "segment_count": len(segments) if isinstance(segments, list) else 0,
        "speakers": speakers,
    }


def _extract_speakers_for_list(segments: object) -> list[str]:
    if not isinstance(segments, list):
        return []

    speakers: list[str] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        speaker = _clean_list_speaker(str(segment.get("speaker") or ""))
        text = str(segment.get("text") or "")
        if speaker in {"", "Speaker"}:
            speaker = _speaker_from_caption_prefix(text) or speaker
        if not speaker or _is_bad_list_speaker(speaker):
            continue
        if speaker not in speakers:
            speakers.append(speaker)

    if len(speakers) > 1:
        speakers = [speaker for speaker in speakers if speaker != "Speaker"]
    return speakers


def _clean_list_speaker(value: str) -> str:
    speaker = re.sub(r"\([^)]*\)", "", value)
    speaker = re.sub(r"\b(?:meeting host|host|visitor|domain_disabled|domain disabled)\b", "", speaker, flags=re.IGNORECASE)
    speaker = re.sub(r"[\s:,-]+$", "", speaker).strip()
    if speaker.lower().startswith("language "):
        return "Speaker"
    if speaker and speaker == speaker.lower() and speaker not in {"you", "speaker"}:
        speaker = " ".join(word[:1].upper() + word[1:] for word in speaker.split())
    if speaker.lower() in {"you", "speaker"}:
        speaker = speaker[:1].upper() + speaker[1:].lower()
    return speaker or "Speaker"


def _is_bad_list_speaker(value: str) -> bool:
    lower = value.strip().lower()
    return lower in {"", "participants", "language english", "english"} or bool(
        re.fullmatch(r"[a-z]{3}-[a-z]{4}-[a-z]{3}", lower)
    )


def _speaker_from_caption_prefix(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    cleaned = re.sub(
        r"^language\s+(?:english|hindi|spanish|french|german|portuguese|japanese|korean|chinese)\s+",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    if not cleaned or "domain_disabled" in cleaned.lower() or " visitor" in cleaned.lower():
        return ""

    colon_match = re.match(r"^([A-Za-z][A-Za-z\s.'-]{1,60}):\s+\S+", cleaned)
    if colon_match:
        return _clean_list_speaker(colon_match.group(1))

    words = cleaned.split()
    for size in range(2, min(3, len(words) - 1) + 1):
        prefix = words[:size]
        remainder = words[size:]
        if _looks_like_name_prefix(prefix) and _starts_like_caption_for_list(remainder):
            return _clean_list_speaker(" ".join(prefix))
    return ""


def _looks_like_name_prefix(words: list[str]) -> bool:
    if not 2 <= len(words) <= 3:
        return False
    normalized = [re.sub(r"[^A-Za-z]", "", word) for word in words]
    normalized = [word for word in normalized if word]
    if len(normalized) != len(words):
        return False
    first = normalized[0].lower()
    if _is_common_caption_start_for_list(first):
        return False
    return all(2 <= len(word) <= 24 and not _is_common_caption_start_for_list(word.lower()) for word in normalized)


def _starts_like_caption_for_list(words: list[str]) -> bool:
    if not words:
        return False
    first = re.sub(r"[^A-Za-z]", "", words[0]).lower()
    return bool(first) and _is_common_caption_start_for_list(first)


def _is_common_caption_start_for_list(word: str) -> bool:
    return word in {
        "yeah",
        "yes",
        "no",
        "okay",
        "ok",
        "so",
        "and",
        "but",
        "in",
        "the",
        "from",
        "here",
        "heres",
        "hey",
        "hi",
        "thanks",
        "we",
        "i",
        "im",
        "you",
        "it",
        "is",
    }


def _meeting_payload(meeting: Meeting, include_metadata: bool = True) -> dict:
    summary_status = meeting.summary_status or "not_started"
    if meeting.summary and summary_status == "not_started":
        summary_status = "completed"
    cleanup_status = meeting.cleanup_status or "not_started"
    try:
        generated_notes = json.loads(meeting.generated_notes or "[]")
    except json.JSONDecodeError:
        generated_notes = []

    payload = {
        "id": meeting.id,
        "original_filename": meeting.original_filename,
        "status": meeting.status,
        "summary": meeting.summary,
        "summary_status": summary_status,
        "summary_error": meeting.summary_error,
        "summary_preset": meeting.summary_preset,
        "generated_notes": generated_notes if isinstance(generated_notes, list) else [],
        "processing_seconds": meeting.processing_seconds,
        "summary_seconds": meeting.summary_seconds,
        "cleanup_status": cleanup_status,
        "cleanup_error": meeting.cleanup_error,
        "cleanup_seconds": meeting.cleanup_seconds,
        "error": meeting.error,
        "created_at": meeting.created_at.isoformat(),
        "updated_at": meeting.updated_at.isoformat(),
    }
    if include_metadata:
        payload.update(_transcript_metadata(meeting))
    return payload


def _cached_generated_note(meeting: Meeting, preset: str) -> dict | None:
    try:
        generated_notes = json.loads(meeting.generated_notes or "[]")
    except json.JSONDecodeError:
        return None
    if not isinstance(generated_notes, list):
        return None
    for note in generated_notes:
        if note.get("preset") == preset and note.get("content"):
            return note
    return None


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
        meeting_code=request.meeting_code if request else None,
        source_url=request.source_url if request else None,
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

    preset = request.preset if request else "short"
    cached_note = _cached_generated_note(meeting, preset)
    if cached_note:
        meeting.summary = cached_note.get("content")
        meeting.summary_status = "completed"
        meeting.summary_error = None
        meeting.summary_preset = preset
        meeting.summary_seconds = cached_note.get("seconds")
        db.commit()
        db.refresh(meeting)
        return _meeting_payload(meeting)

    meeting.summary_status = "queued"
    meeting.summary_error = None
    meeting.summary_preset = preset
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


@app.post("/api/meetings/{meeting_id}/chat")
def ask_meeting_chat(
    meeting_id: int,
    request: ChatRequest,
    db: Session = Depends(get_db),
) -> dict:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        raise HTTPException(status_code=404, detail="Meeting not found")
    if meeting.status != "completed":
        raise HTTPException(status_code=409, detail="Meeting transcript is available after transcription is completed")
    if not meeting.transcript_path:
        raise HTTPException(status_code=404, detail="Transcript not found")

    path = Path(meeting.transcript_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Transcript not found")

    transcript = _load_transcript(path)
    segments = transcript.get("cleaned_segments") or transcript.get("segments") or []
    if not isinstance(segments, list):
        segments = []
    if transcript.get("live", False):
        segments = compact_live_segments(segments)

    try:
        answer = answer_meeting_question(
            segments=segments,
            question=request.question,
            meeting_title=meeting.original_filename,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"answer": answer}


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

    if meeting.status == "completed" and meeting.transcript_path:
        path = Path(meeting.transcript_path)
        if path.exists():
            transcript = _load_transcript(path)
            segments = transcript.get("segments", [])
            if not isinstance(segments, list):
                segments = []
            if transcript.get("live", False):
                segments = compact_live_segments(segments)
            payload.update(
                {
                    "segments": segments,
                    "cleaned_segments": transcript.get("cleaned_segments", []),
                    "language": transcript.get("language"),
                    "language_probability": transcript.get("language_probability"),
                    "is_live": bool(transcript.get("live", False)),
                    "source": transcript.get("source"),
                    "meeting_code": transcript.get("meeting_code"),
                    "source_url": transcript.get("source_url"),
                    "started_at": transcript.get("started_at"),
                    "finished_at": transcript.get("finished_at"),
                    "segment_count": len(segments),
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
