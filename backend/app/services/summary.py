from typing import Any

from ..config import Settings
from .llm import configured_api_key, generate_text, missing_key_message


COMMON_GUARDRAILS = (
    "Use only information explicitly present in the transcript. "
    "Do not fabricate, infer, or assume missing details such as names, responsibilities, "
    "deadlines, timelines, technical implementations, decisions, risks, metrics, or action items "
    "unless they are directly stated or strongly supported by the conversation context. "
    
    "If information is unclear, incomplete, contradictory, or affected by poor transcript quality, "
    "explicitly state the uncertainty instead of guessing. "
    
    "Do not attribute statements, decisions, or tasks to a speaker unless speaker attribution "
    "is clearly identifiable from the transcript. "
    
    "Separate factual transcript content from AI-generated observations or recommendations. "
    "Never present AI assumptions as confirmed meeting outcomes. "
    
    "Prioritize accuracy, traceability, and faithfulness to the transcript over completeness."
)

SUMMARY_PRESETS = {
    "short": {
        "label": "Short Summary",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return concise Markdown with: Short Summary, Key Discussion Points, "
            "Decisions, and Action Items. Keep it brief."
        ),
    },
    "detailed": {
        "label": "Detailed Summary",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return detailed Markdown notes with: Executive Summary, Discussion by Topic, "
            "Key Decisions, Risks/Open Questions, and Action Items. Preserve important context."
        ),
    },
    "citations": {
        "label": "Detailed Summary with Citations",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return detailed Markdown notes with citations after important claims. Citations must "
            "come only from transcript timestamps and speakers, like [Speaker 2, 2:20-2:37]. "
            "Include: Executive Summary, Key Discussion Points, Decisions, and Action Items."
        ),
    },
    "actions": {
        "label": "Summary and Action Items",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return Markdown focused on outcomes: Short Summary, Decisions, Action Items, "
            "Owners if mentioned, Due Dates if mentioned, and Follow-ups. Use 'None captured' "
            "when details are missing."
        ),
    },
    "team_sync": {
        "label": "Team Sync - Project Updates",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return Markdown formatted for a team sync: Project Updates, Progress Since Last Sync, "
            "Blockers, Decisions, Next Steps, and Owners. Do not invent owners or dates."
        ),
    },
    "advice": {
        "label": "Smart AI Advice",
        "instructions": (
             f"{COMMON_GUARDRAILS}\n\n"
            "Return Markdown with: Situation Summary, What Matters Most, Risks, Suggested Next "
            "Moves, Better Questions to Ask, and Action Items. Separate facts from advice and do "
            "not invent details."
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
            "You create meeting notes from transcripts. "
            f"Use this preset: {preset_config['label']}. "
            f"{preset_config['instructions']} "
            "If decisions or action items are not present, say 'None captured'."
        ),
        input_text=transcript[:60000],
        max_output_tokens=active_settings.summary_max_output_tokens,
        timeout=active_settings.summary_timeout_seconds,
    )
