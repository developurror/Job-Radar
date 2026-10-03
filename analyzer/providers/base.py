"""LlmProvider interface.

The analyzer never talks to an LLM backend directly — it goes through this
interface, so local Ollama, host llama.cpp, and hosted APIs are interchangeable.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class CompletionOptions:
    temperature: float = 0.2
    max_tokens: int = 1024
    json_mode: bool = False


@dataclass
class ToolCall:
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolResult:
    content: str
    tool_calls: list[ToolCall] = field(default_factory=list)


class LlmProvider(ABC):
    """Common interface over local (Ollama / llama.cpp) and hosted LLM backends."""

    provider_name: str = "unknown"

    @abstractmethod
    def complete(self, prompt: str, options: CompletionOptions | None = None) -> str:
        """Return the model's text response for a plain prompt."""

    @abstractmethod
    def complete_with_tools(self, prompt: str, tools: list[dict[str, Any]]) -> ToolResult:
        """Run one agentic step: the model may answer directly or request tool calls."""

    @abstractmethod
    def ping(self) -> bool:
        """Lightweight reachability check. True when the backend answers."""

    @abstractmethod
    def close(self) -> None:
        """Release underlying HTTP resources."""
