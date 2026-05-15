import json
import re
from typing import Any

from ..config import Settings
from .llm import configured_api_key, generate_text, missing_key_message


def _chunks(segments: list[dict[str, Any]], max_chars: int = 4500) -> list[list[dict[str, Any]]]:
    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_chars = 0

    for index, segment in enumerate(segments):
        item = {
            "index": index,
            "speaker": segment.get("speaker", ""),
            "start": segment.get("start", 0),
            "end": segment.get("end", 0),
            "text": segment.get("text", ""),
        }
        item_chars = len(item["text"]) + 80
        if current and current_chars + item_chars > max_chars:
            chunks.append(current)
            current = []
            current_chars = 0
        current.append(item)
        current_chars += item_chars

    if current:
        chunks.append(current)
    return chunks


def _parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    return json.loads(cleaned)


def _repair_json_response(text: str, active_settings: Settings) -> dict[str, Any]:
    repaired = generate_text(
        settings=active_settings,
        instructions=(
            "Repair malformed JSON. Return only valid JSON with this exact shape: "
            "{\"segments\":[{\"index\":0,\"text\":\"cleaned text\"}]}. "
            "Do not add explanations, markdown, or extra keys."
        ),
        input_text=text[:12000],
        max_output_tokens=active_settings.cleanup_max_output_tokens,
        timeout=active_settings.cleanup_timeout_seconds,
        json_mode=True,
    )
    return _parse_json_object(repaired)


def cleanup_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    active_settings = Settings()
    if not configured_api_key(active_settings):
        raise RuntimeError(missing_key_message(active_settings))
    if not segments:
        return []

    cleaned_by_index: dict[int, str] = {}

    for chunk in _chunks(segments):
        output_text = generate_text(
            settings=active_settings,
            instructions=(
                "Clean meeting transcript segment text without changing the conversation structure. "
                "Preserve the original speaker turn, meaning, timestamps, speaker labels, and segment count. "
                "Do not summarize, paraphrase, or convert dialogue into reported speech. Never write phrases "
                "like \"Aman said\", \"Manthan replied\", or \"the speaker asked\" unless those exact words "
                "were spoken. Keep first-person/second-person wording as spoken. Fix only obvious ASR mistakes, "
                "punctuation, casing, brand names, speaker names, repeated caption fragments, repeated embedded "
                "speaker labels, and technical terms. Do not add new facts. Return only JSON in this "
                "shape: {\"segments\":[{\"index\":0,\"text\":\"cleaned text\"}]}. "
                "Use double quotes for all JSON strings. Do not return markdown or explanations."
            ),
            input_text=json.dumps({"segments": chunk}, ensure_ascii=False),
            max_output_tokens=active_settings.cleanup_max_output_tokens,
            timeout=active_settings.cleanup_timeout_seconds,
            json_mode=True,
        )
        try:
            payload = _parse_json_object(output_text)
        except json.JSONDecodeError:
            payload = _repair_json_response(output_text, active_settings)
        for item in payload.get("segments", []):
            index = int(item["index"])
            text = str(item["text"]).strip()
            if text:
                cleaned_by_index[index] = text

    cleaned_segments = []
    for index, segment in enumerate(segments):
        cleaned_segments.append(
            {
                **segment,
                "text": cleaned_by_index.get(index, segment.get("text", "")),
            }
        )
    return cleaned_segments
