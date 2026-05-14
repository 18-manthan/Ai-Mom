from typing import Any

from ..config import Settings
from .llm import configured_api_key, generate_text, missing_key_message


COMMON_GUARDRAILS = (
    "You are iMann, a senior meeting copilot that turns noisy transcripts into useful notes. "
    "Use only information explicitly present in the transcript. Do not fabricate, infer, or "
    "assume missing details such as names, responsibilities, deadlines, timelines, technical "
    "implementations, decisions, risks, metrics, or action items unless they are directly stated "
    "or strongly supported by the conversation context. "
    "If information is unclear, incomplete, contradictory, or affected by poor transcript quality, "
    "state the uncertainty instead of guessing. "
    "Ignore platform/caption noise such as 'turn on captions', 'end the call', repeated meeting "
    "codes, language labels, UI button text, or duplicated live-caption fragments unless those "
    "words are clearly part of the actual conversation. "
    "Do not attribute statements, decisions, or tasks to a speaker unless speaker attribution is "
    "clearly identifiable from the transcript. "
    "If a section has no evidence, write 'None captured'. "
    "Write clean Markdown with clear headings and bullets. Do not use tables."
)

SUMMARY_PRESETS = {
    "short": {
        "label": "Short Summary",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return concise Markdown in this exact structure:\n"
            "## Short Summary\n"
            "Write 2-4 sentences that capture the meeting's core purpose and outcome.\n"
            "## Key Discussion Points\n"
            "- 3-6 bullets only, focused on what was actually discussed.\n"
            "## Decisions\n"
            "- List confirmed decisions only, or 'None captured'.\n"
            "## Action Items\n"
            "- List task, owner, and due date only when mentioned; otherwise 'None captured'."
        ),
    },
    "detailed": {
        "label": "Detailed Summary",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return detailed Markdown in this exact structure:\n"
            "## Executive Summary\n"
            "Summarize the full meeting in a polished but factual paragraph.\n"
            "## Discussion by Topic\n"
            "Group the conversation into meaningful topic sections. Each topic should include the "
            "important context, constraints, and conclusions from the transcript.\n"
            "## Decisions\n"
            "- Confirmed decisions only, or 'None captured'.\n"
            "## Action Items\n"
            "- Task, owner, due date, and context when available. Use 'Unknown' only for missing "
            "owner/due date on a clearly stated task.\n"
            "## Risks / Blockers\n"
            "- Risks, blockers, dependencies, or concerns explicitly discussed.\n"
            "## Open Questions\n"
            "- Questions left unresolved, or 'None captured'."
        ),
    },
    "citations": {
        "label": "Detailed Summary with Citations",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return detailed Markdown with lightweight citations after important claims. Use only "
            "the transcript speaker and timestamp shown in the input, for example [Aman, 125.4] "
            "or [Speaker, 02:20] when exact names are unavailable. Do not invent citations.\n"
            "Use this structure:\n"
            "## Executive Summary\n"
            "## Topic Notes With Evidence\n"
            "## Decisions\n"
            "## Action Items\n"
            "## Open Questions"
        ),
    },
    "actions": {
        "label": "Summary and Action Items",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return outcome-focused Markdown in this exact structure:\n"
            "## Summary\n"
            "## Decisions\n"
            "## Action Items\n"
            "For every action item, write: - Task: ... | Owner: ... | Due: ... | Evidence: ...\n"
            "Use 'Unknown' for missing owner/due date only when the task itself is clearly stated.\n"
            "## Owners\n"
            "List people and their responsibilities only if stated.\n"
            "## Due Dates\n"
            "List explicit dates or timing commitments only.\n"
            "## Follow-ups\n"
            "List follow-up conversations, reviews, or documents requested."
        ),
    },
    "team_sync": {
        "label": "Team Sync - Project Updates",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return Markdown formatted for a team sync/status update in this exact structure:\n"
            "## Project Updates\n"
            "## Progress Since Last Sync\n"
            "## Blockers\n"
            "## Risks\n"
            "## Decisions\n"
            "## Next Steps\n"
            "## Owners\n"
            "Keep it useful for a manager reading after the meeting. Do not invent owners or dates."
        ),
    },
    "advice": {
        "label": "Smart AI Advice",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return Markdown as an expert meeting advisor in this exact structure:\n"
            "## Situation Summary\n"
            "State only what the transcript supports.\n"
            "## What Matters Most\n"
            "Explain the highest-leverage themes or concerns from the meeting.\n"
            "## Risks / Watchouts\n"
            "Risks must be grounded in the transcript.\n"
            "## Recommended Next Actions\n"
            "Recommendations may be AI advice, but label them as recommendations and keep them "
            "practical.\n"
            "## Better Questions To Ask\n"
            "Suggest sharper follow-up questions that would help the team clarify the work.\n"
            "## Transcript Facts vs AI Advice\n"
            "Separate confirmed facts from recommendations."
        ),
    },
}   


def _format_transcript(segments: list[dict[str, Any]]) -> str:
    lines = []
    for segment in segments:
        speaker = segment.get("speaker", "Speaker")
        start = segment.get("start", 0)
        text = segment.get("text", "")
        lines.append(f"[{start:>7}] {speaker}: {text}")
    return "\n".join(lines)


def generate_summary(segments: list[dict[str, Any]], preset: str = "short") -> str:
    active_settings = Settings()
    if not configured_api_key(active_settings):
        return f"{missing_key_message(active_settings)} Summary generation skipped."

    transcript = _format_transcript(segments)
    if not transcript.strip():
        return "No transcript text was generated."

    preset_config = SUMMARY_PRESETS.get(preset, SUMMARY_PRESETS["short"])
    return generate_text(
        settings=active_settings,
        instructions=(
            "You create production-quality meeting notes from transcripts. "
            f"Use this preset: {preset_config['label']}. "
            f"{preset_config['instructions']} "
            "Keep the response direct, useful, and easy to scan."
        ),
        input_text=transcript[:60000],
        max_output_tokens=active_settings.summary_max_output_tokens,
        timeout=active_settings.summary_timeout_seconds,
    )
