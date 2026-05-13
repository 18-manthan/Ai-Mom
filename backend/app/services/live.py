import json
import re
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Meeting


_LOCKS_GUARD = threading.Lock()
_PATH_LOCKS: dict[str, threading.Lock] = {}


def start_live_meeting(
    db: Session,
    title: str | None = None,
    source: str = "google_meet",
    meeting_code: str | None = None,
    source_url: str | None = None,
) -> Meeting:
    name = (title or "").strip() or "Live meeting"
    source_name = (source or "").strip() or "unknown"
    code = (meeting_code or "").strip() or None
    url = (source_url or "").strip() or None

    meeting = Meeting(
        original_filename=name,
        status="processing",
        upload_path="",
        cleanup_status="not_started",
        summary_status="not_started",
    )
    db.add(meeting)
    db.commit()
    db.refresh(meeting)

    transcript_path = settings.transcript_dir / f"live-meeting-{meeting.id}.json"
    payload = {
        "meeting_id": meeting.id,
        "original_filename": meeting.original_filename,
        "source": source_name,
        "meeting_code": code,
        "source_url": url,
        "live": True,
        "started_at": meeting.created_at.isoformat(),
        "finished_at": None,
        "language": None,
        "language_probability": None,
        "summary": None,
        "segments": [],
    }

    transcript_path.parent.mkdir(parents=True, exist_ok=True)
    _write_payload(transcript_path, payload)

    meeting.transcript_path = str(transcript_path)
    meeting.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(meeting)
    return meeting


def append_live_segment(
    db: Session,
    meeting: Meeting,
    segment: dict[str, Any],
) -> dict[str, Any]:
    if meeting.status == "completed":
        raise ValueError("Live meeting is already finished.")
    if meeting.status == "failed":
        raise ValueError("Live meeting has failed.")
    if not meeting.transcript_path:
        raise RuntimeError("Live transcript is not ready.")

    text = str(segment.get("text") or "").strip()
    if not text:
        raise ValueError("Segment text is required.")

    transcript_path = Path(meeting.transcript_path)
    with _path_lock(transcript_path):
        payload = _read_payload(transcript_path, meeting)
        segments = payload.setdefault("segments", [])

        now_offset = max(0.0, (datetime.utcnow() - meeting.created_at).total_seconds())
        start = segment.get("start")
        end = segment.get("end")
        normalized = {
            "speaker": str(segment.get("speaker") or "Speaker").strip() or "Speaker",
            "start": round(float(start if start is not None else now_offset), 2),
            "end": round(float(end if end is not None else start if start is not None else now_offset), 2),
            "text": text,
            "source": str(segment.get("source") or payload.get("source") or "unknown"),
            "is_final": bool(segment.get("is_final", True)),
        }

        external_id = str(segment.get("external_id") or "").strip()
        if external_id:
            normalized["external_id"] = external_id
            for index, existing in enumerate(segments):
                if existing.get("external_id") == external_id:
                    segments[index] = {**existing, **normalized}
                    break
            else:
                segments.append(normalized)
        else:
            segments.append(normalized)

        payload["updated_at"] = datetime.utcnow().isoformat()
        _write_payload(transcript_path, payload)

    meeting.updated_at = datetime.utcnow()
    db.commit()
    return normalized


def finish_live_meeting(db: Session, meeting: Meeting) -> Meeting:
    if meeting.status == "completed":
        return meeting
    if not meeting.transcript_path:
        raise RuntimeError("Live transcript is not ready.")

    finished_at = datetime.utcnow()
    transcript_path = Path(meeting.transcript_path)
    with _path_lock(transcript_path):
        payload = _read_payload(transcript_path, meeting)
        payload["segments"] = compact_live_segments(payload.get("segments", []))
        payload["finished_at"] = finished_at.isoformat()
        payload["updated_at"] = finished_at.isoformat()
        _write_payload(transcript_path, payload)

    meeting.status = "completed"
    meeting.processing_seconds = round((finished_at - meeting.created_at).total_seconds(), 2)
    meeting.updated_at = finished_at
    db.commit()
    db.refresh(meeting)
    return meeting


def _read_payload(path: Path, meeting: Meeting) -> dict[str, Any]:
    if path.exists():
        text = path.read_text(encoding="utf-8")
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            payload, _ = json.JSONDecoder().raw_decode(text)
            if isinstance(payload, dict):
                _write_payload(path, payload)
                return payload
            raise

    return {
        "meeting_id": meeting.id,
        "original_filename": meeting.original_filename,
        "source": "unknown",
        "live": True,
        "started_at": meeting.created_at.isoformat(),
        "finished_at": None,
        "language": None,
        "language_probability": None,
        "summary": meeting.summary,
        "segments": [],
    }


def compact_live_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compacted: list[dict[str, Any]] = []

    for segment in segments:
        text = _clean_caption_text(str(segment.get("text") or ""))
        if _is_rejected_caption(text, str(segment.get("speaker") or "")):
            continue

        speaker = str(segment.get("speaker") or "Speaker").strip() or "Speaker"
        if str(segment.get("text") or "").strip().lower().startswith("you "):
            speaker = "You"
        label_split = _split_leading_participant_label(text) if speaker != "You" else None
        if label_split:
            speaker, text = label_split

        normalized = {
            **segment,
            "speaker": speaker,
            "text": text,
        }

        if not compacted:
            compacted.append(normalized)
            continue

        absorbed = False
        for previous in reversed(compacted[-20:]):
            if _is_caption_update(str(previous.get("text") or ""), text):
                previous_text = str(previous.get("text") or "")
                merged_text = _merge_caption_text(previous_text, text)
                previous_start = previous.get("start", normalized.get("start", 0))
                previous_end = previous.get("end", previous.get("start", 0))
                previous.update(normalized)
                previous["text"] = merged_text
                previous["start"] = min(float(previous_start), float(normalized.get("start", 0)))
                previous["end"] = max(float(previous_end or 0), float(normalized.get("end", 0) or 0))
                absorbed = True
                break
        if absorbed:
            continue

        compacted.append(normalized)

    return _drop_recent_duplicate_echoes(compacted)


def _clean_caption_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    cleaned = re.sub(r"^(?:you|speaker)\s+", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def _is_rejected_caption(text: str, speaker: str) -> bool:
    lower = text.lower()
    speaker_lower = speaker.lower().strip()
    if not text:
        return True
    if speaker_lower in {"pin", "dial-in"}:
        return True
    if (
        lower == "you"
        or _is_ui_noise_text(text)
        or lower.startswith("joined as ")
        or lower.startswith("language ")
        or "meeting host" in lower
        or lower == "live captions have been turned off"
        or lower.startswith("turn off microphone")
        or "or share this joining info with others you want in the meeting" in lower
        or "end the call or just leave" in lower
        or "just leave the call" in lower
        or "leave the call if you don't want to end it" in lower
        or "leave the call if you don’t want to end it" in lower
        or "end it for everyone else" in lower
    ):
        return True
    if _looks_like_repeated_short_name(text):
        return True
    if _looks_like_name_only(text):
        return True
    if re.fullmatch(r"[\d\s()+#-]{7,}", text):
        return True
    return False


def _is_ui_noise_text(text: str) -> bool:
    cleaned = _clean_caption_text(text)
    lower = cleaned.lower()
    words = lower.split()
    language_names = {
        "english",
        "hindi",
        "spanish",
        "french",
        "german",
        "portuguese",
        "japanese",
        "korean",
        "chinese",
    }
    if lower in language_names:
        return True
    if re.fullmatch(r"[a-z]{3}-[a-z]{4}-[a-z]{3}", lower):
        return True
    if 1 <= len(words) <= 3 and _looks_like_participant_label(words):
        return True
    return False


def _is_caption_update(previous: str, current: str) -> bool:
    for previous_clean in _caption_compare_keys(previous):
        for current_clean in _caption_compare_keys(current):
            if _caption_keys_overlap(previous_clean, current_clean):
                return True
    return False


def _merge_caption_text(previous: str, current: str) -> str:
    previous_clean = _clean_caption_text(previous)
    current_clean = _clean_caption_text(current)
    if not previous_clean:
        return current_clean
    if not current_clean:
        return previous_clean
    if previous_clean == current_clean:
        return previous_clean
    previous_key = _caption_compare_key(previous_clean)
    current_key = _caption_compare_key(current_clean)
    if previous_key and current_key:
        if current_key.startswith(previous_key) or previous_key in current_key:
            return current_clean
        if previous_key.startswith(current_key) or current_key in previous_key:
            return previous_clean

    previous_words = previous_clean.split()
    current_words = current_clean.split()
    previous_key_words = _caption_compare_key(previous_clean).split()
    current_key_words = _caption_compare_key(current_clean).split()
    max_overlap = min(40, len(previous_key_words), len(current_key_words), len(previous_words), len(current_words))
    for size in range(max_overlap, 3, -1):
        if previous_key_words[-size:] == current_key_words[:size]:
            return " ".join([*previous_words, *current_words[size:]])
        if current_key_words[-size:] == previous_key_words[:size]:
            return " ".join([*current_words, *previous_words[size:]])

    return current_clean if len(current_clean) >= len(previous_clean) else previous_clean


def _drop_recent_duplicate_echoes(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    filtered: list[dict[str, Any]] = []

    for segment in segments:
        current_key = _caption_compare_key(str(segment.get("text") or ""))
        current_start = float(segment.get("start", 0) or 0)
        current_words = len(current_key.split())
        is_echo = False

        for previous in filtered[-3:]:
            previous_key = _caption_compare_key(str(previous.get("text") or ""))
            previous_words = len(previous_key.split())
            previous_end = float(previous.get("end", previous.get("start", 0)) or 0)
            if current_start - previous_end > 3:
                continue
            if previous_words >= 8 and current_words >= 8 and _caption_keys_overlap(previous_key, current_key):
                is_echo = True
                break

        if not is_echo:
            filtered.append(segment)

    return filtered


def _caption_keys_overlap(previous_clean: str, current_clean: str) -> bool:
    if not previous_clean or not current_clean:
        return False
    if previous_clean.startswith(current_clean) or current_clean.startswith(previous_clean):
        return True
    if len(previous_clean) >= 24 and current_clean in previous_clean:
        return True
    if len(current_clean) >= 24 and previous_clean in current_clean:
        return True

    previous_words = previous_clean.split()
    current_words = current_clean.split()
    common = 0
    for previous_word, current_word in zip(previous_words, current_words):
        if previous_word != current_word:
            break
        common += 1

    smaller = min(len(previous_words), len(current_words))
    if common >= 8 and common >= int(smaller * 0.6):
        return True

    max_overlap = min(40, len(previous_words), len(current_words))
    for size in range(max_overlap, 3, -1):
        if previous_words[-size:] == current_words[:size]:
            return True
        if current_words[-size:] == previous_words[:size]:
            return True
    return False


def _caption_compare_keys(text: str) -> set[str]:
    variants = {_caption_compare_key(text)}
    stripped = _strip_leading_participant_label(text)
    if stripped:
        variants.add(_caption_compare_key(stripped))
    return {variant for variant in variants if variant}


def _caption_compare_key(text: str) -> str:
    cleaned = _clean_caption_text(text).lower()
    cleaned = re.sub(r"[^a-z0-9]+", " ", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _looks_like_repeated_short_name(text: str) -> bool:
    words = _caption_compare_key(text).split()
    if len(words) not in {2, 4, 6}:
        return False
    half = len(words) // 2
    return words[:half] == words[half:]


def _looks_like_name_only(text: str) -> bool:
    words = _words_for_label_detection(text)
    common_caption_words = {
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
        "you",
        "it",
        "is",
    }
    if any(word.lower() in common_caption_words for word in words):
        return False
    return 2 <= len(words) <= 4 and _looks_like_participant_label(words)


def _strip_leading_participant_label(text: str) -> str:
    split = _split_leading_participant_label(text)
    return split[1] if split else ""


def _split_leading_participant_label(text: str) -> tuple[str, str] | None:
    cleaned = _clean_caption_text(text)
    words = cleaned.split()
    for size in range(2, min(4, len(words) - 1) + 1):
        prefix = words[:size]
        remainder = words[size:]
        if _looks_like_participant_label(prefix) and _starts_like_caption(remainder):
            return " ".join(prefix).strip(), " ".join(remainder).strip()
    return None


def _looks_like_participant_label(words: list[str]) -> bool:
    if len(words) < 2:
        return False
    normalized = [re.sub(r"[^A-Za-z]", "", word) for word in words]
    normalized = [word for word in normalized if word]
    if len(normalized) != len(words):
        return False

    common_caption_starts = {
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
        "you",
        "it",
        "is",
    }
    if normalized[0].lower() in common_caption_starts:
        return False

    short_or_name_like = 0
    for word in normalized:
        if len(word) <= 3 or word[:1].isupper():
            short_or_name_like += 1
    return short_or_name_like == len(normalized)


def _starts_like_caption(words: list[str]) -> bool:
    if not words:
        return False
    first = re.sub(r"[^A-Za-z]", "", words[0]).lower()
    if not first:
        return False
    common_starts = {
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
        "i'm",
        "you",
        "it",
        "is",
    }
    return first in common_starts


def _words_for_label_detection(text: str) -> list[str]:
    cleaned = _clean_caption_text(text)
    cleaned = re.sub(r"\([^)]*\)", "", cleaned)
    return [word for word in cleaned.split() if word]


def _path_lock(path: Path) -> threading.Lock:
    key = str(path.resolve())
    with _LOCKS_GUARD:
        lock = _PATH_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _PATH_LOCKS[key] = lock
        return lock


def _write_payload(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{threading.get_ident()}.tmp")
    temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temp_path.replace(path)
