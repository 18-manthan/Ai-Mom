from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./backend/mom.db"
    upload_dir: Path = Path("backend/uploads")
    transcript_dir: Path = Path("backend/transcripts")
    whisper_model: str = "small"
    whisper_compute_type: str = "int8"
    whisper_beam_size: int = 1
    whisper_cpu_threads: int = 0
    whisper_num_workers: int = 1
    whisper_language: str = ""
    enable_diarization: bool = True
    max_speakers: int = 4
    openai_api_key: str = ""
    openai_model: str = "gpt-5-mini"
    summary_max_output_tokens: int = 700
    summary_timeout_seconds: float = 60.0
    cleanup_max_output_tokens: int = 4000
    cleanup_timeout_seconds: float = 90.0

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
