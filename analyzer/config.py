"""Environment-driven configuration for the analyzer service.

All settings come from environment variables so the same container image can run
in local-Ollama, host-llama.cpp, or hosted-API mode without rebuilds.
See .env.example for documentation of every variable.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


VALID_PROVIDER_NAMES = ("ollama", "llamacpp", "hosted")


def _read_env(variable_name: str, default: str) -> str:
    return os.environ.get(variable_name, default).strip()


@dataclass
class AnalyzerSettings:
    """Resolved analyzer configuration."""

    llm_provider: str = "ollama"
    llm_deep_provider: str | None = None
    llm_model: str = "hermes3:8b"
    llm_deep_model: str | None = None
    llm_timeout_seconds: float = 120.0
    ollama_base_url: str = "http://llm:11434"
    llamacpp_base_url: str = "http://host.docker.internal:8080"
    hosted_base_url: str = ""
    hosted_api_key: str = ""
    embedding_model: str = "bge-small-en-v1.5"


def load_settings_from_env() -> AnalyzerSettings:
    """Build settings from environment variables, applying documented defaults."""
    deep_provider_raw = _read_env("LLM_DEEP_PROVIDER", "")
    deep_model_raw = _read_env("LLM_DEEP_MODEL", "")
    return AnalyzerSettings(
        llm_provider=_read_env("LLM_PROVIDER", "ollama").lower(),
        llm_deep_provider=deep_provider_raw.lower() or None,
        llm_model=_read_env("LLM_MODEL", "hermes3:8b"),
        llm_deep_model=deep_model_raw or None,
        llm_timeout_seconds=float(_read_env("LLM_TIMEOUT_SECONDS", "120")),
        ollama_base_url=_read_env("OLLAMA_BASE_URL", "http://llm:11434"),
        llamacpp_base_url=_read_env("LLAMACPP_BASE_URL", "http://host.docker.internal:8080"),
        hosted_base_url=_read_env("HOSTED_BASE_URL", ""),
        hosted_api_key=_read_env("HOSTED_API_KEY", ""),
        embedding_model=_read_env("EMBEDDING_MODEL", "bge-small-en-v1.5"),
    )
