from typing import Any

from openai import OpenAI

from ..config import Settings


def provider_name(settings: Settings) -> str:
    provider = (settings.ai_provider or "openai").strip().lower()
    if provider not in {"openai", "groq"}:
        raise RuntimeError("AI_PROVIDER must be either 'openai' or 'groq'.")
    return provider


def configured_model(settings: Settings) -> str:
    return settings.groq_model if provider_name(settings) == "groq" else settings.openai_model


def configured_api_key(settings: Settings) -> str:
    return settings.groq_api_key if provider_name(settings) == "groq" else settings.openai_api_key


def missing_key_message(settings: Settings) -> str:
    key_name = "GROQ_API_KEY" if provider_name(settings) == "groq" else "OPENAI_API_KEY"
    return f"{key_name} is not configured."


def generate_text(
    *,
    settings: Settings,
    instructions: str,
    input_text: str,
    max_output_tokens: int,
    timeout: float,
    json_mode: bool = False,
) -> str:
    provider = provider_name(settings)
    if provider == "groq":
        return _generate_text_groq(
            settings=settings,
            instructions=instructions,
            input_text=input_text,
            max_output_tokens=max_output_tokens,
            timeout=timeout,
            json_mode=json_mode,
        )
    return _generate_text_openai(
        settings=settings,
        instructions=instructions,
        input_text=input_text,
        max_output_tokens=max_output_tokens,
        timeout=timeout,
    )


def _generate_text_openai(
    *,
    settings: Settings,
    instructions: str,
    input_text: str,
    max_output_tokens: int,
    timeout: float,
) -> str:
    client = OpenAI(api_key=settings.openai_api_key)
    create_args: dict[str, Any] = {
        "model": settings.openai_model,
        "instructions": instructions,
        "input": input_text,
        "max_output_tokens": max_output_tokens,
        "timeout": timeout,
    }
    if settings.openai_model.startswith("gpt-5"):
        create_args["reasoning"] = {"effort": "minimal"}

    response = client.responses.create(**create_args)
    return response.output_text.strip()


def _generate_text_groq(
    *,
    settings: Settings,
    instructions: str,
    input_text: str,
    max_output_tokens: int,
    timeout: float,
    json_mode: bool,
) -> str:
    client = OpenAI(api_key=settings.groq_api_key, base_url=settings.groq_base_url)
    create_args: dict[str, Any] = {
        "model": settings.groq_model,
        "messages": [
            {"role": "system", "content": instructions},
            {"role": "user", "content": input_text},
        ],
        "max_tokens": max_output_tokens,
        "temperature": 0.1,
        "timeout": timeout,
    }
    if json_mode:
        create_args["response_format"] = {"type": "json_object"}

    try:
        response = client.chat.completions.create(**create_args)
    except Exception:
        if not json_mode:
            raise
        create_args.pop("response_format", None)
        response = client.chat.completions.create(**create_args)
    return (response.choices[0].message.content or "").strip()
