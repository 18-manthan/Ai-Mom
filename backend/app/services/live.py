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
        "speakers": [],
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
        compacted_segments = compact_live_segments(payload.get("segments", []))
        payload["segments"] = compacted_segments
        payload["speakers"] = _distinct_speakers(compacted_segments)
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
        "speakers": [],
        "segments": [],
    }


def compact_live_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    compacted: list[dict[str, Any]] = []
    known_speakers = _known_speakers_from_segments(segments)

    for segment in segments:
        text = _clean_caption_text(str(segment.get("text") or ""))
        if _is_rejected_caption(text, str(segment.get("speaker") or "")):
            continue

        speaker = _normalize_speaker_label(str(segment.get("speaker") or "Speaker").strip() or "Speaker")
        if speaker.lower().startswith("language "):
            speaker = "Speaker"
        if str(segment.get("text") or "").strip().lower().startswith("you "):
            speaker = "You"
        label_split = _split_leading_participant_label(text) if speaker != "You" else None
        if label_split:
            speaker, text = label_split
            text = _strip_repeated_speaker_prefixes(text, speaker)
        if speaker == "Speaker":
            teams_split = _split_repeated_teams_speaker(text)
            if teams_split:
                speaker, text = teams_split
        speaker = _display_speaker_name(speaker)

        normalized_segment = {
            **segment,
            "speaker": speaker,
            "text": text,
        }
        normalized_segments = _split_embedded_speaker_turns(normalized_segment, known_speakers)

        for normalized in normalized_segments:
            _append_compacted_segment(compacted, normalized)

    return _drop_recent_duplicate_echoes(compacted)


def _append_compacted_segment(compacted: list[dict[str, Any]], normalized: dict[str, Any]) -> None:
    text = _clean_caption_text(str(normalized.get("text") or ""))
    if not text:
        return
    normalized["text"] = text

    if not compacted:
        compacted.append(normalized)
        return

    speaker = str(normalized.get("speaker") or "Speaker").strip() or "Speaker"
    for previous in reversed(compacted[-40:]):
        previous_speaker = str(previous.get("speaker") or "Speaker").strip() or "Speaker"
        if _can_merge_speaker_updates(previous_speaker, speaker) and _is_caption_update(str(previous.get("text") or ""), text):
            previous_text = str(previous.get("text") or "")
            merged_text = _merge_caption_text(previous_text, text)
            previous_start = previous.get("start", normalized.get("start", 0))
            previous_end = previous.get("end", previous.get("start", 0))
            previous.update(normalized)
            if speaker == "Speaker" and previous_speaker != "Speaker":
                previous["speaker"] = previous_speaker
            previous["text"] = merged_text
            previous["start"] = min(float(previous_start), float(normalized.get("start", 0)))
            previous["end"] = max(float(previous_end or 0), float(normalized.get("end", 0) or 0))
            return

    compacted.append(normalized)


def _known_speakers_from_segments(segments: list[dict[str, Any]]) -> list[str]:
    speakers: list[str] = []
    for segment in segments:
        speaker = _normalize_speaker_label(str(segment.get("speaker") or "").strip())
        if _is_real_speaker_name(speaker) and speaker not in speakers:
            speakers.append(speaker)
    return sorted(speakers, key=len, reverse=True)


def _is_real_speaker_name(speaker: str) -> bool:
    cleaned = speaker.strip()
    lower = cleaned.lower()
    if not cleaned or lower in {"you", "speaker", "participants", "language english"}:
        return False
    if lower.startswith("language "):
        return False
    return len(cleaned.split()) >= 2


def _normalize_speaker_label(value: str) -> str:
    speaker = re.sub(r"[\s:,-]+$", "", str(value or "").strip())
    if not speaker:
        return "Speaker"

    words = speaker.split()
    while len(words) > 2:
        last = re.sub(r"[^A-Za-z]", "", words[-1]).lower()
        if _is_common_caption_start(last) or last in {"how", "what", "when", "where", "why", "who", "which"}:
            words.pop()
            continue
        break
    return _display_speaker_name(" ".join(words))


def _split_embedded_speaker_turns(segment: dict[str, Any], known_speakers: list[str]) -> list[dict[str, Any]]:
    text = _clean_caption_text(str(segment.get("text") or ""))
    if not text or not known_speakers:
        return [segment]

    matches: list[tuple[int, int, str]] = []
    for speaker in known_speakers:
        pattern = re.compile(rf"(?:^|(?<=[.!?]\s))({re.escape(speaker)})(?::)?\s+", re.IGNORECASE)
        for match in pattern.finditer(text):
            matches.append((match.start(1), match.end(), speaker))

    if not matches:
        return [segment]

    matches.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    deduped: list[tuple[int, int, str]] = []
    last_end = -1
    for match in matches:
        if match[0] < last_end:
            continue
        deduped.append(match)
        last_end = match[1]

    start_time = float(segment.get("start", 0) or 0)
    end_time = float(segment.get("end", start_time) or start_time)
    parts: list[dict[str, Any]] = []

    prefix = text[: deduped[0][0]].strip()
    if prefix:
        parts.append({**segment, "text": prefix})

    for index, (label_start, text_start, speaker) in enumerate(deduped):
        next_label_start = deduped[index + 1][0] if index + 1 < len(deduped) else len(text)
        turn_text = text[text_start:next_label_start].strip()
        if not turn_text:
            continue
        turn_text = _strip_repeated_speaker_prefixes(turn_text, speaker)
        parts.append({**segment, "speaker": speaker, "text": turn_text})

    if not parts:
        return [segment]

    duration = max(0.0, end_time - start_time)
    step = duration / max(1, len(parts))
    for index, part in enumerate(parts):
        part_start = start_time + (step * index)
        part_end = start_time + (step * (index + 1))
        part["start"] = round(part_start, 2)
        part["end"] = round(max(part_start, part_end), 2)
        part["speaker"] = _normalize_speaker_label(str(part.get("speaker") or "Speaker"))
    return parts


def _distinct_speakers(segments: list[dict[str, Any]]) -> list[str]:
    speakers: list[str] = []
    has_generic_speaker = False
    for segment in segments:
        speaker = _display_speaker_name(str(segment.get("speaker") or "").strip())
        if speaker == "Speaker":
            has_generic_speaker = True
            continue
        if not speaker or speaker.lower() in {"participants", "language english"}:
            continue
        if speaker not in speakers:
            speakers.append(speaker)
    if speakers:
        return speakers
    return ["Speaker"] if has_generic_speaker else []


def _can_merge_speaker_updates(previous: str, current: str) -> bool:
    previous_clean = previous.strip().lower() or "speaker"
    current_clean = current.strip().lower() or "speaker"
    return previous_clean == current_clean or "speaker" in {previous_clean, current_clean}


def _display_speaker_name(value: str) -> str:
    speaker = str(value or "").strip()
    if speaker.lower() in {"you", "speaker"}:
        return speaker[:1].upper() + speaker[1:].lower()
    if speaker and speaker == speaker.lower():
        return " ".join(word[:1].upper() + word[1:] for word in speaker.split())
    return speaker


def _clean_caption_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    cleaned = re.sub(
        r"^language\s+(?:english|hindi|spanish|french|german|portuguese|japanese|korean|chinese)\s+",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
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
        or lower.startswith("participants ")
        or "domain_disabled" in lower
        or " visitor" in lower
        or lower.startswith("joined as ")
        or lower.startswith("language ")
        or "meeting host" in lower
        or lower == "live captions have been turned off"
        or lower.startswith("turn off microphone")
        or lower == "turn on rtt for this call"
        or lower == "get the mobile app"
        or lower.startswith("editor spellcheck")
        or lower.startswith("use enter or spacebar")
        or lower.startswith("restart teams")
        or "microsoft 365" in lower
        or "already have a subscription" in lower
        or "for each meeting and call" in lower
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


def _split_repeated_teams_speaker(text: str) -> tuple[str, str] | None:
    cleaned = _clean_caption_text(text)
    words = cleaned.split()
    for size in range(min(4, len(words) - 1), 1, -1):
        prefix = words[:size]
        if any(_is_common_caption_start(re.sub(r"[^A-Za-z]", "", word).lower()) for word in prefix):
            continue
        if not _looks_like_participant_label(prefix):
            continue
        speaker = re.sub(r"[\s:,-]+$", "", " ".join(prefix)).strip()
        pattern = re.compile(rf"(?:^|(?<=[.!?]\s))({re.escape(speaker)})\s+", re.IGNORECASE)
        matches = list(pattern.finditer(cleaned))
        if len(matches) < 2:
            continue
        stripped = _strip_repeated_speaker_prefixes(cleaned, speaker)
        if stripped:
            return speaker, stripped
    return None


def _strip_repeated_speaker_prefixes(text: str, speaker: str) -> str:
    speaker = re.sub(r"[\s:,-]+$", "", speaker).strip()
    if not speaker:
        return text
    pattern = re.compile(rf"(?:^|(?<=[.!?]\s))({re.escape(speaker)})\s+", re.IGNORECASE)
    stripped = pattern.sub("", text)
    return re.sub(r"\s+", " ", stripped).strip()


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
        "hello",
        "hey",
        "hi",
        "good",
        "thanks",
        "we",
        "i",
        "you",
        "it",
        "is",
        "now",
        "please",
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
        if (_looks_like_participant_label(prefix) or _looks_like_lowercase_participant_prefix(prefix, remainder)) and _starts_like_caption(remainder):
            speaker = re.sub(r"[\s:,-]+$", "", " ".join(prefix)).strip()
            return speaker, " ".join(remainder).strip()
    return None


def _looks_like_participant_label(words: list[str]) -> bool:
    if len(words) < 2:
        return False
    if any(re.search(r"[.!?]", word) for word in words):
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
        "hello",
        "hey",
        "hi",
        "good",
        "thanks",
        "we",
        "i",
        "you",
        "it",
        "is",
        "now",
        "please",
    }
    if normalized[0].lower() in common_caption_starts:
        return False

    short_or_name_like = 0
    for word in normalized:
        if len(word) <= 3 or word[:1].isupper():
            short_or_name_like += 1
    return short_or_name_like == len(normalized)


def _looks_like_lowercase_participant_prefix(prefix: list[str], remainder: list[str]) -> bool:
    if not 2 <= len(prefix) <= 3 or not _starts_like_caption(remainder):
        return False
    normalized = [re.sub(r"[^A-Za-z]", "", word) for word in prefix]
    normalized = [word for word in normalized if word]
    if len(normalized) != len(prefix):
        return False
    first = normalized[0].lower()
    if _is_common_caption_start(first):
        return False
    return all(
        word == word.lower() and 2 <= len(word) <= 24 and not _is_common_caption_start(word.lower())
        for word in normalized
    )


def _starts_like_caption(words: list[str]) -> bool:
    if not words:
        return False
    first = re.sub(r"[^A-Za-z]", "", words[0]).lower()
    if not first:
        return False
    return _is_common_caption_start(first)


def _is_common_caption_start(word: str) -> bool:
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
        "hello",
        "hey",
        "hi",
        "good",
        "thanks",
        "we",
        "i",
        "im",
        "i'm",
        "you",
        "it",
        "is",
        "now",
        "please",
    }
    return word in common_starts


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
