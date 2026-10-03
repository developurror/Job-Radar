"""Single OpenAI-compatible chat-completions client shared by all providers.

Ollama, llama.cpp's server, and hosted OpenAI-style APIs all speak the
``/v1/chat/completions`` protocol, so one client covers every backend. The three
provider classes below are thin configurations over it.
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from .base import CompletionOptions, LlmProvider, ToolCall, ToolResult


class OpenAiCompatibleProvider(LlmProvider):
    def __init__(
        self,
        *,
        provider_name: str,
        base_url: str,
        model: str,
        api_key: str = "",
        timeout_seconds: float = 120.0,
    ) -> None:
        if not base_url:
            raise ValueError(f"Cannot build '{provider_name}' provider: base URL is empty.")
        self.provider_name = provider_name
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds
        # trust_env=False: the backends this client talks to are infrastructure the
        # user controls (local Ollama, host llama.cpp, or an explicitly configured
        # hosted endpoint). Ambient proxy env vars must not reroute those calls,
        # and malformed proxy entries would otherwise break client construction.
        self._http_client = httpx.Client(timeout=timeout_seconds, trust_env=False)

    def _request_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _chat_completions_url(self) -> str:
        return f"{self.base_url}/v1/chat/completions"

    def complete(self, prompt: str, options: CompletionOptions | None = None) -> str:
        resolved_options = options or CompletionOptions()
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": resolved_options.temperature,
            "max_tokens": resolved_options.max_tokens,
        }
        if resolved_options.json_mode:
            payload["response_format"] = {"type": "json_object"}
        response = self._http_client.post(
            self._chat_completions_url(), json=payload, headers=self._request_headers()
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"]

    def complete_with_tools(self, prompt: str, tools: list[dict[str, Any]]) -> ToolResult:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "tools": tools,
            "tool_choice": "auto",
        }
        response = self._http_client.post(
            self._chat_completions_url(), json=payload, headers=self._request_headers()
        )
        response.raise_for_status()
        message = response.json()["choices"][0]["message"]
        tool_calls = [
            ToolCall(
                name=tool_call["function"]["name"],
                arguments=json.loads(tool_call["function"]["arguments"] or "{}"),
            )
            for tool_call in message.get("tool_calls") or []
        ]
        return ToolResult(content=message.get("content") or "", tool_calls=tool_calls)

    def ping(self) -> bool:
        """True when the backend answers GET /v1/models with a 2xx status."""
        try:
            response = self._http_client.get(
                f"{self.base_url}/v1/models", headers=self._request_headers()
            )
            return 200 <= response.status_code < 300
        except Exception:
            return False

    def close(self) -> None:
        self._http_client.close()


class OllamaProvider(OpenAiCompatibleProvider):
    """Local Ollama server (the `llm` compose service)."""

    def __init__(self, *, base_url: str, model: str, timeout_seconds: float = 120.0) -> None:
        super().__init__(
            provider_name="ollama",
            base_url=base_url,
            model=model,
            timeout_seconds=timeout_seconds,
        )


class LlamaCppProvider(OpenAiCompatibleProvider):
    """llama.cpp server on the Docker host (OpenAI-compatible endpoint)."""

    def __init__(self, *, base_url: str, model: str, timeout_seconds: float = 120.0) -> None:
        # llama.cpp mostly ignores the model name; kept for interface uniformity.
        super().__init__(
            provider_name="llamacpp",
            base_url=base_url,
            model=model,
            timeout_seconds=timeout_seconds,
        )


class HostedProvider(OpenAiCompatibleProvider):
    """Hosted OpenAI-compatible API (key required)."""

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str,
        timeout_seconds: float = 120.0,
    ) -> None:
        if not api_key:
            raise ValueError(
                "Cannot build 'hosted' provider: HOSTED_API_KEY is empty. "
                "Set it in the environment or .env file."
            )
        super().__init__(
            provider_name="hosted",
            base_url=base_url,
            model=model,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
        )
