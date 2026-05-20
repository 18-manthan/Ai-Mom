from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    database_url: str = "sqlite:///./backend/mom.db"
    upload_dir: Path = Path("backend/uploads")
    transcript_dir: Path = Path("backend/transcripts")
    ai_provider: str = "openai"
    openai_api_key: str = ""
    openai_model: str = "gpt-5-mini"
    groq_api_key: str = ""
    groq_model: str = "llama-3.3-70b-versatile"
    groq_base_url: str = "https://api.groq.com/openai/v1"
    summary_max_output_tokens: int = 700
    summary_timeout_seconds: float = 60.0
    chat_max_output_tokens: int = 900
    chat_timeout_seconds: float = 60.0
    cleanup_max_output_tokens: int = 4000
    cleanup_timeout_seconds: float = 90.0

    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
