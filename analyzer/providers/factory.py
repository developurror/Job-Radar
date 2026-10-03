"""Build triage + deep-analysis providers from AnalyzerSettings.

The triage route (validators, scoring) uses LLM_PROVIDER. The deep-analysis route
(company intel agent) uses LLM_DEEP_PROVIDER when set, otherwise falls back to
LLM_PROVIDER — the "cheap local triage, powerful hosted deep-dive" split from the spec.
"""
from __future__ import annotations

from ..config import VALID_PROVIDER_NAMES, AnalyzerSettings
from .base import LlmProvider
from .openai_compatible import HostedProvider, LlamaCppProvider, OllamaProvider


def build_provider(provider_name: str, settings: AnalyzerSettings) -> LlmProvider:
    """Build one provider by name. Raises ValueError on unknown names."""
    normalized_name = provider_name.strip().lower()
    timeout = settings.llm_timeout_seconds
    if normalized_name == "ollama":
        return OllamaProvider(
            base_url=settings.ollama_base_url, model=settings.llm_model, timeout_seconds=timeout
        )
    if normalized_name == "llamacpp":
        return LlamaCppProvider(
            base_url=settings.llamacpp_base_url, model=settings.llm_model, timeout_seconds=timeout
        )
    if normalized_name == "hosted":
        return HostedProvider(
            base_url=settings.hosted_base_url,
            model=settings.llm_model,
            api_key=settings.hosted_api_key,
            timeout_seconds=timeout,
        )
    raise ValueError(
        f"Unknown LLM provider '{provider_name}'. "
        f"Valid options: {', '.join(VALID_PROVIDER_NAMES)}."
    )


def build_triage_provider(settings: AnalyzerSettings) -> LlmProvider:
    """Provider for bulk triage: validators and scoring."""
    return build_provider(settings.llm_provider, settings)


def build_deep_provider(settings: AnalyzerSettings) -> LlmProvider:
    """Provider for deep analysis. Falls back to the triage provider when
    LLM_DEEP_PROVIDER is unset; may use a distinct model via LLM_DEEP_MODEL."""
    deep_name = settings.llm_deep_provider or settings.llm_provider
    deep_provider = build_provider(deep_name, settings)
    if settings.llm_deep_model:
        deep_provider.model = settings.llm_deep_model
    return deep_provider
