"""Payload tests for the OpenAI-compatible providers. No network access: each
provider's HTTP client is swapped for a recording stand-in."""
from __future__ import annotations

import httpx

from analyzer.providers.openai_compatible import (
    HostedProvider,
    LlamaCppProvider,
    OllamaProvider,
)


class RecordingHttpClient:
    """Stands in for httpx.Client: records posted payloads, replies canned JSON."""

    def __init__(self, response_content: str = "canned model reply"):
        self.response_content = response_content
        self.posted_payloads: list[dict] = []

    def post(self, url: str, json: dict | None = None, headers: dict | None = None) -> httpx.Response:
        self.posted_payloads.append(json or {})
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": self.response_content}}]},
            request=httpx.Request("POST", url),
        )


def complete_with_recording_client(provider) -> dict:
    """Run one complete() call through a recording client; return the payload sent."""
    recording_client = RecordingHttpClient()
    provider._http_client = recording_client
    reply = provider.complete("Say something brief.")
    assert reply == "canned model reply"
    assert len(recording_client.posted_payloads) == 1
    return recording_client.posted_payloads[0]


def test_ollama_provider_disables_reasoning_in_payload():
    provider = OllamaProvider(base_url="http://localhost:11434", model="gemma4:e4b")
    payload = complete_with_recording_client(provider)
    assert payload["reasoning_effort"] == "none"


def test_llamacpp_provider_omits_reasoning_effort():
    provider = LlamaCppProvider(base_url="http://localhost:8080", model="local-model")
    payload = complete_with_recording_client(provider)
    assert "reasoning_effort" not in payload


def test_hosted_provider_omits_reasoning_effort():
    provider = HostedProvider(
        base_url="https://api.example.com", model="hosted-model", api_key="secret-key"
    )
    payload = complete_with_recording_client(provider)
    assert "reasoning_effort" not in payload
