"""Tests for the provider factory. No network access; env vars are mocked."""
from __future__ import annotations

import pytest

from analyzer.config import AnalyzerSettings, load_settings_from_env
from analyzer.providers.factory import build_deep_provider, build_provider, build_triage_provider
from analyzer.providers.openai_compatible import HostedProvider, LlamaCppProvider, OllamaProvider


MANAGED_ENV_VARS = (
    "LLM_PROVIDER",
    "LLM_DEEP_PROVIDER",
    "LLM_MODEL",
    "LLM_DEEP_MODEL",
    "LLM_TIMEOUT_SECONDS",
    "OLLAMA_BASE_URL",
    "LLAMACPP_BASE_URL",
    "HOSTED_BASE_URL",
    "HOSTED_API_KEY",
    "EMBEDDING_MODEL",
)


def settings_with_env(monkeypatch, **overrides) -> AnalyzerSettings:
    for variable_name in MANAGED_ENV_VARS:
        monkeypatch.delenv(variable_name, raising=False)
    for variable_name, value in overrides.items():
        monkeypatch.setenv(variable_name, value)
    return load_settings_from_env()


def test_default_settings_select_ollama(monkeypatch):
    settings = settings_with_env(monkeypatch)
    triage_provider = build_triage_provider(settings)
    assert isinstance(triage_provider, OllamaProvider)
    assert triage_provider.provider_name == "ollama"
    assert triage_provider.base_url == "http://llm:11434"
    assert triage_provider.model == "hermes3:8b"


def test_llamacpp_provider_uses_host_base_url(monkeypatch):
    settings = settings_with_env(monkeypatch, LLM_PROVIDER="llamacpp")
    triage_provider = build_triage_provider(settings)
    assert isinstance(triage_provider, LlamaCppProvider)
    assert triage_provider.provider_name == "llamacpp"
    assert triage_provider.base_url == "http://host.docker.internal:8080"


def test_hosted_provider_receives_base_url_and_key(monkeypatch):
    settings = settings_with_env(
        monkeypatch,
        LLM_PROVIDER="hosted",
        HOSTED_BASE_URL="https://api.example.com/v1",
        HOSTED_API_KEY="secret-key",
    )
    triage_provider = build_triage_provider(settings)
    assert isinstance(triage_provider, HostedProvider)
    assert triage_provider.provider_name == "hosted"
    assert triage_provider.base_url == "https://api.example.com/v1"
    assert triage_provider.api_key == "secret-key"


def test_hosted_provider_without_key_raises_clear_error(monkeypatch):
    settings = settings_with_env(
        monkeypatch, LLM_PROVIDER="hosted", HOSTED_BASE_URL="https://api.example.com/v1"
    )
    with pytest.raises(ValueError, match="HOSTED_API_KEY"):
        build_triage_provider(settings)


def test_deep_provider_falls_back_to_triage_provider(monkeypatch):
    settings = settings_with_env(monkeypatch, LLM_PROVIDER="llamacpp")
    deep_provider = build_deep_provider(settings)
    triage_provider = build_triage_provider(settings)
    assert deep_provider.provider_name == triage_provider.provider_name == "llamacpp"


def test_deep_provider_override_selects_hosted_while_triage_stays_local(monkeypatch):
    settings = settings_with_env(
        monkeypatch,
        LLM_PROVIDER="ollama",
        LLM_DEEP_PROVIDER="hosted",
        HOSTED_BASE_URL="https://api.example.com/v1",
        HOSTED_API_KEY="secret-key",
    )
    assert build_triage_provider(settings).provider_name == "ollama"
    assert build_deep_provider(settings).provider_name == "hosted"


def test_deep_model_override_applies_only_to_deep_provider(monkeypatch):
    settings = settings_with_env(
        monkeypatch, LLM_PROVIDER="ollama", LLM_DEEP_MODEL="bigger-model"
    )
    assert build_triage_provider(settings).model == "hermes3:8b"
    assert build_deep_provider(settings).model == "bigger-model"


def test_invalid_provider_name_raises_clear_error(monkeypatch):
    settings = settings_with_env(monkeypatch, LLM_PROVIDER="skynet")
    with pytest.raises(ValueError, match="Unknown LLM provider 'skynet'"):
        build_triage_provider(settings)


def test_error_message_lists_valid_options(monkeypatch):
    settings = settings_with_env(monkeypatch)
    with pytest.raises(ValueError) as error_info:
        build_provider("not-a-provider", settings)
    message = str(error_info.value)
    assert "ollama" in message and "llamacpp" in message and "hosted" in message
