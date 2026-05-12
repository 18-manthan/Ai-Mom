import json
import re
from typing import Any

from openai import OpenAI

from ..config import settings


def _chunks(segments: list[dict[str, Any]], max_chars: int = 12000) -> list[list[dict[str, Any]]]:
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


def cleanup_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured.")
    if not segments:
        return []

    client = OpenAI(api_key=settings.openai_api_key)
    cleaned_by_index: dict[int, str] = {}

    for chunk in _chunks(segments):
        create_args: dict[str, Any] = {
            "model": settings.openai_model,
            "instructions": (
                "Clean meeting transcript segment text. Preserve meaning, timestamps, speaker labels, "
                "and segment count. Fix obvious ASR mistakes, punctuation, casing, brand names, "
                "speaker names, and technical terms. Do not add new facts. Return only JSON in this "
                "shape: {\"segments\":[{\"index\":0,\"text\":\"cleaned text\"}]}."
            ),
            "input": json.dumps({"segments": chunk}, ensure_ascii=False),
            "max_output_tokens": settings.cleanup_max_output_tokens,
            "timeout": settings.cleanup_timeout_seconds,
        }
        if settings.openai_model.startswith("gpt-5"):
            create_args["reasoning"] = {"effort": "minimal"}

        response = client.responses.create(**create_args)
        payload = _parse_json_object(response.output_text)
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
