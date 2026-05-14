from typing import Any

from ..config import settings
from .llm import configured_api_key, generate_text, missing_key_message


def _format_transcript(segments: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for segment in segments:
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        speaker = str(segment.get("speaker") or "Speaker").strip() or "Speaker"
        start = float(segment.get("start") or 0)
        minutes = int(start // 60)
        seconds = int(start % 60)
        lines.append(f"[{minutes:02d}:{seconds:02d}] {speaker}: {text}")
    return "\n".join(lines)


def answer_meeting_question(
    *,
    segments: list[dict[str, Any]],
    question: str,
    meeting_title: str,
) -> str:
    if not configured_api_key(settings):
        raise RuntimeError(missing_key_message(settings))

    clean_question = question.strip()
    if not clean_question:
        raise ValueError("Question is required.")

    transcript = _format_transcript(segments)
    if not transcript:
        return "I could not find transcript text for this meeting yet."

    # Keep the prompt bounded for long meetings while preserving recent context.
    max_chars = 28000
    if len(transcript) > max_chars:
        transcript = transcript[-max_chars:]
        transcript = "[Transcript truncated to the latest available context]\n" + transcript

    return generate_text(
        settings=settings,
        instructions=(
            "You are iMann, an expert meeting chat assistant and meeting copilot. "
            "Your only source of truth is the provided meeting transcript. Your task is to "
            "understand the user's question, find the relevant information inside the transcript, "
            "and provide a precise, useful answer. Answer up to the point: no generic filler, "
            "no invented details, and no assumptions beyond what the transcript supports. "
            "When the user asks for insights, decisions, action items, risks, blockers, follow-ups, "
            "or speaker-specific details, extract them clearly from the transcript and organize "
            "the answer in a readable way. If the transcript does not contain enough information, "
            "say that clearly and mention what is missing. Use speaker names and timestamps when "
            "they help the user verify the answer. Keep the tone professional, helpful, and concise."
        ),
        input_text=(
            f"Meeting: {meeting_title}\n\n"
            f"Transcript:\n{transcript}\n\n"
            f"User question:\n{clean_question}\n\n"
            "Answer:"
        ),
        max_output_tokens=settings.chat_max_output_tokens,
        timeout=settings.chat_timeout_seconds,
    )
