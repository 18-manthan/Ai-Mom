from functools import lru_cache
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel

from ..config import settings


@lru_cache(maxsize=1)
def _model() -> WhisperModel:
    return WhisperModel(
        settings.whisper_model,
        device="cpu",
        compute_type=settings.whisper_compute_type,
        cpu_threads=settings.whisper_cpu_threads,
        num_workers=settings.whisper_num_workers,
    )


def transcribe(audio_path: Path) -> dict[str, Any]:
    segments, info = _model().transcribe(
        str(audio_path),
        beam_size=settings.whisper_beam_size,
        language=settings.whisper_language or None,
        condition_on_previous_text=False,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )

    transcript_segments = [
        {
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip(),
        }
        for segment in segments
        if segment.text.strip()
    ]

    return {
        "language": info.language,
        "language_probability": round(info.language_probability, 4),
        "segments": transcript_segments,
    }
