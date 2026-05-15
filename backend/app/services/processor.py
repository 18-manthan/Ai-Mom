import json
import time
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal
from ..models import Meeting


def _set_status(db: Session, meeting: Meeting, status: str, error: str | None = None) -> None:
    meeting.status = status
    meeting.error = error
    meeting.updated_at = datetime.utcnow()
    db.commit()


def process_meeting(meeting_id: int) -> None:
    from .audio import extract_wav
    from .diarization import assign_speakers
    from .transcription import transcribe

    db = SessionLocal()
    started_at = time.perf_counter()
    try:
        meeting = db.get(Meeting, meeting_id)
        if meeting is None:
            return

        _set_status(db, meeting, "processing")
        upload_path = Path(meeting.upload_path)
        audio_path = settings.upload_dir / f"meeting-{meeting.id}.wav"
        transcript_path = settings.transcript_dir / f"meeting-{meeting.id}.json"

        extract_wav(upload_path, audio_path)
        meeting.audio_path = str(audio_path)
        db.commit()

        transcription = transcribe(audio_path)
        if settings.enable_diarization:
            segments = assign_speakers(audio_path, transcription["segments"])
        else:
            segments = [
                {**segment, "speaker": "Speaker 1"}
                for segment in transcription["segments"]
            ]
        transcription["segments"] = segments

        payload = {
            "meeting_id": meeting.id,
            "original_filename": meeting.original_filename,
            "language": transcription.get("language"),
            "language_probability": transcription.get("language_probability"),
            "summary": meeting.summary,
            "segments": segments,
        }

        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        meeting.transcript_path = str(transcript_path)
        meeting.cleanup_status = "not_started"
        meeting.cleanup_error = None
        meeting.summary_status = "not_started"
        meeting.summary_error = None
        meeting.processing_seconds = round(time.perf_counter() - started_at, 2)
        _set_status(db, meeting, "completed")
    except Exception as exc:
        meeting = db.get(Meeting, meeting_id)
        if meeting is not None:
            meeting.processing_seconds = round(time.perf_counter() - started_at, 2)
            _set_status(db, meeting, "failed", str(exc))
    finally:
        db.close()


def _set_summary_status(
    db: Session,
    meeting: Meeting,
    status: str,
    error: str | None = None,
) -> None:
    meeting.summary_status = status
    meeting.summary_error = error
    meeting.updated_at = datetime.utcnow()
    db.commit()


def _set_cleanup_status(
    db: Session,
    meeting: Meeting,
    status: str,
    error: str | None = None,
) -> None:
    meeting.cleanup_status = status
    meeting.cleanup_error = error
    meeting.updated_at = datetime.utcnow()
    db.commit()


def process_cleanup(meeting_id: int) -> None:
    from .cleanup import cleanup_segments
    from .live import compact_live_segments

    db = SessionLocal()
    started_at = time.perf_counter()
    try:
        meeting = db.get(Meeting, meeting_id)
        if meeting is None:
            return

        _set_cleanup_status(db, meeting, "processing")
        if not meeting.transcript_path:
            raise RuntimeError("Transcript is not ready yet.")

        transcript_path = Path(meeting.transcript_path)
        if not transcript_path.exists():
            raise RuntimeError("Transcript file was not found.")

        payload = json.loads(transcript_path.read_text(encoding="utf-8"))
        segments = payload.get("segments", [])
        if payload.get("live", False):
            segments = compact_live_segments(segments if isinstance(segments, list) else [])
            payload["segments"] = segments
            payload["speakers"] = _distinct_payload_speakers(segments)
        cleaned_segments = cleanup_segments(segments)

        payload["cleaned_segments"] = cleaned_segments
        payload["summary"] = None
        payload["summary_preset"] = None
        payload["generated_notes"] = []
        transcript_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        meeting.cleanup_seconds = round(time.perf_counter() - started_at, 2)
        meeting.summary = None
        meeting.summary_preset = None
        meeting.summary_status = "not_started"
        meeting.summary_error = None
        meeting.summary_seconds = None
        meeting.generated_notes = None
        _set_cleanup_status(db, meeting, "completed")
    except Exception as exc:
        meeting = db.get(Meeting, meeting_id)
        if meeting is not None:
            meeting.cleanup_seconds = round(time.perf_counter() - started_at, 2)
            _set_cleanup_status(db, meeting, "failed", str(exc))
    finally:
        db.close()


def _distinct_payload_speakers(segments: list[dict]) -> list[str]:
    speakers: list[str] = []
    for segment in segments:
        speaker = str(segment.get("speaker") or "").strip()
        if speaker and speaker not in {"Speaker", "Participants"} and speaker not in speakers:
            speakers.append(speaker)
    return speakers


def process_summary(meeting_id: int, preset: str = "short") -> None:
    from .summary import generate_summary

    db = SessionLocal()
    started_at = time.perf_counter()
    try:
        meeting = db.get(Meeting, meeting_id)
        if meeting is None:
            return

        _set_summary_status(db, meeting, "processing")
        if not meeting.transcript_path:
            raise RuntimeError("Transcript is not ready yet.")

        transcript_path = Path(meeting.transcript_path)
        if not transcript_path.exists():
            raise RuntimeError("Transcript file was not found.")

        payload = json.loads(transcript_path.read_text(encoding="utf-8"))
        segments = payload.get("cleaned_segments") or payload.get("segments", [])
        generated_notes = _load_generated_notes(meeting.generated_notes)
        cached_note = _find_generated_note(generated_notes, preset)
        if cached_note:
            meeting.summary = cached_note.get("content")
            meeting.summary_preset = preset
            meeting.summary_seconds = cached_note.get("seconds")
            payload["summary"] = cached_note.get("content")
            payload["summary_preset"] = preset
            payload["generated_notes"] = generated_notes
            transcript_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            _set_summary_status(db, meeting, "completed")
            return

        summary = generate_summary(segments, preset)
        note = {
            "id": uuid4().hex,
            "preset": preset,
            "title": _notes_title(preset),
            "content": summary,
            "created_at": datetime.utcnow().isoformat(),
            "seconds": round(time.perf_counter() - started_at, 2),
        }
        generated_notes.insert(0, note)

        payload["summary"] = summary
        payload["summary_preset"] = preset
        payload["generated_notes"] = generated_notes
        transcript_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        meeting.summary = summary
        meeting.summary_preset = preset
        meeting.generated_notes = json.dumps(generated_notes)
        meeting.summary_seconds = round(time.perf_counter() - started_at, 2)
        _set_summary_status(db, meeting, "completed")
    except Exception as exc:
        meeting = db.get(Meeting, meeting_id)
        if meeting is not None:
            meeting.summary_seconds = round(time.perf_counter() - started_at, 2)
            _set_summary_status(db, meeting, "failed", str(exc))
    finally:
        db.close()


def _load_generated_notes(raw_notes: str | None) -> list[dict]:
    if not raw_notes:
        return []
    try:
        notes = json.loads(raw_notes)
    except json.JSONDecodeError:
        return []
    return notes if isinstance(notes, list) else []


def _find_generated_note(notes: list[dict], preset: str) -> dict | None:
    for note in notes:
        if note.get("preset") == preset and note.get("content"):
            return note
    return None


def _notes_title(preset: str) -> str:
    titles = {
        "short": "Short Summary",
        "detailed": "Detailed Summary",
        "citations": "Detailed Summary with Citations",
        "actions": "Summary and Action Items",
        "team_sync": "Team Sync - Project Updates",
        "advice": "Smart AI Advice",
    }
    return titles.get(preset, "Meeting notes")
