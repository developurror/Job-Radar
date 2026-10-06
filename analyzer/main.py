"""FastAPI entrypoint for the analyzer service (Phase 0).

Endpoints (per the spec's API sketch):
  GET  /health     -> provider wiring + backend reachability
  POST /v1/embed   -> {texts[]} -> {vectors[]}
  POST /v1/generate -> {prompt, max_tokens?} -> {text}  (Phase 2: serves llm_judge)
  POST /v1/analyze/company -> {companyName} -> {intel}  (Phase 4: Hermes agent)
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import embeddings, hermes, learning
from .config import AnalyzerSettings, load_settings_from_env
from .providers.base import CompletionOptions
from .providers.factory import build_deep_provider, build_triage_provider


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=256)


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    model: str
    dimensions: int


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    max_tokens: int = Field(default=512, ge=1, le=4096)


class GenerateResponse(BaseModel):
    text: str
    provider: str


class ReviewEvidenceInput(BaseModel):
    """One pre-verified employee review supplied by the API service
    (Phase 11: the OpenWeb Ninja Glassdoor path). The API resolved the
    company identity by the platform's company ID before sending these;
    Hermes treats them as verified evidence, citable like a fetched page."""

    text: str = Field(min_length=1, max_length=8000)
    sourceTitle: str = Field(default="", max_length=300)
    sourceUrl: str = Field(default="", max_length=1000)
    kind: str = Field(default="review", max_length=20)


class CompanyIntelRequest(BaseModel):
    companyName: str = Field(min_length=1, max_length=200)
    reviewEvidence: list[ReviewEvidenceInput] = Field(default_factory=list, max_length=20)


class CompanyIntelResponse(BaseModel):
    intel: dict


class LearnExample(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    label: str


class LearnTarget(BaseModel):
    id: int
    text: str = Field(min_length=1, max_length=20000)


class LearnScoreBatchRequest(BaseModel):
    examples: list[LearnExample] = Field(max_length=2000)
    targets: list[LearnTarget] = Field(max_length=2000)


class LearnScoreEntry(BaseModel):
    id: int
    probability: int


class LearnScoreBatchResponse(BaseModel):
    modelReady: bool
    labelCount: int
    positiveCount: int
    negativeCount: int
    scores: list[LearnScoreEntry]


def create_app(settings: AnalyzerSettings | None = None) -> FastAPI:
    """Build the app. Accepts explicit settings so tests can inject their own."""
    resolved_settings = settings or load_settings_from_env()
    triage_provider = build_triage_provider(resolved_settings)
    deep_provider = build_deep_provider(resolved_settings)

    @asynccontextmanager
    async def app_lifespan(_: FastAPI):
        yield
        triage_provider.close()
        deep_provider.close()

    app = FastAPI(title="JobRadar Analyzer", version="0.1.0", lifespan=app_lifespan)

    @app.get("/health")
    def health_check() -> dict:
        return {
            "status": "ok",
            "triage_provider": triage_provider.provider_name,
            "deep_provider": deep_provider.provider_name,
            "triage_reachable": triage_provider.ping(),
            "deep_reachable": deep_provider.ping(),
            "embedding_model": resolved_settings.embedding_model,
        }

    @app.post("/v1/embed", response_model=EmbedResponse)
    def embed_texts_endpoint(request: EmbedRequest) -> EmbedResponse:
        vectors = embeddings.embed_texts(request.texts, model_name=resolved_settings.embedding_model)
        return EmbedResponse(
            vectors=vectors,
            model=embeddings.resolve_model_name(resolved_settings.embedding_model),
            dimensions=len(vectors[0]),
        )

    @app.post("/v1/generate", response_model=GenerateResponse)
    def generate_text_endpoint(request: GenerateRequest) -> GenerateResponse:
        text = triage_provider.complete(
            request.prompt, CompletionOptions(max_tokens=request.max_tokens)
        )
        return GenerateResponse(text=text, provider=triage_provider.provider_name)

    @app.post("/v1/analyze/company", response_model=CompanyIntelResponse)
    def analyze_company_endpoint(request: CompanyIntelRequest) -> CompanyIntelResponse:
        """Hermes deep company analysis (spec F8). Only the company name is
        used — no profile or job-seeker data is involved."""
        try:
            intel = hermes.analyze_company(
                request.companyName,
                deep_provider,
                review_evidence=[
                    review.model_dump() for review in request.reviewEvidence
                ],
            )
        except hermes.HermesError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error
        return CompanyIntelResponse(intel=intel)

    @app.post("/v1/learn/score-batch", response_model=LearnScoreBatchResponse)
    def learn_score_batch_endpoint(
        request: LearnScoreBatchRequest,
    ) -> LearnScoreBatchResponse:
        """Learned match (Phase 6): fit a logistic regression on the user's
        thumbs up/down examples and score the targets against it. Stateless —
        the model lives only for this call."""
        result = learning.score_targets(
            [example.model_dump() for example in request.examples],
            [target.model_dump() for target in request.targets],
            embed_function=lambda texts: embeddings.embed_texts(
                texts, model_name=resolved_settings.embedding_model
            ),
        )
        return LearnScoreBatchResponse(**result)

    return app


app = create_app()
