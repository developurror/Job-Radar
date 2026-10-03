import type { CompanyIntel } from './companies/types.js';

const ANALYZER_BASE_URL = process.env.ANALYZER_BASE_URL ?? 'http://localhost:8000';

export interface EmbedResult {
  vectors: number[][];
  model: string;
  dimensions: number;
}


/** The analyzer's /v1/embed accepts 1–256 texts per request (EmbedRequest in
 *  analyzer/main.py), so larger batches are split into requests it accepts. */
const MAX_TEXTS_PER_EMBED_REQUEST = 256;

/** Embed one batch of at most MAX_TEXTS_PER_EMBED_REQUEST texts. Throws on non-2xx. */
async function embedTextBatch(textBatch: string[]): Promise<EmbedResult> {
  const response = await fetch(`${ANALYZER_BASE_URL}/v1/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: textBatch }),
  });
  if (!response.ok) {
    throw new Error(`Analyzer /v1/embed failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as EmbedResult;
}

/** Batch-embed texts via the analyzer service, chunking to the analyzer's
 *  per-request limit. An empty list is a no-op. Throws on non-2xx. */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) {
    return { vectors: [], model: '', dimensions: 0 };
  }
  const combinedVectors: number[][] = [];
  let model = '';
  let dimensions = 0;
  for (
    let batchStart = 0;
    batchStart < texts.length;
    batchStart += MAX_TEXTS_PER_EMBED_REQUEST
  ) {
    const textBatch = texts.slice(batchStart, batchStart + MAX_TEXTS_PER_EMBED_REQUEST);
    const batchResult = await embedTextBatch(textBatch);
    combinedVectors.push(...batchResult.vectors);
    model = batchResult.model;
    dimensions = batchResult.dimensions;
  }
  return { vectors: combinedVectors, model, dimensions };
}

/** Lightweight reachability check; false when the analyzer is down. */
export async function analyzerHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${ANALYZER_BASE_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/** Generate text via the analyzer's LLM endpoint (serves the llm_judge validator). Throws on non-2xx. */
export async function generateText(prompt: string, maxTokens = 512): Promise<string> {
  const response = await fetch(`${ANALYZER_BASE_URL}/v1/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, max_tokens: maxTokens }),
  });
  if (!response.ok) {
    throw new Error(`Analyzer /v1/generate failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { text: string };
  return body.text;
}

export interface LearnExample {
  text: string;
  label: 'up' | 'down';
}

export interface LearnTarget {
  id: number;
  text: string;
}

export interface LearnScoreBatchResult {
  modelReady: boolean;
  labelCount: number;
  positiveCount: number;
  negativeCount: number;
  scores: { id: number; probability: number }[];
}

/** Learned match (Phase 6): fit a model on the user's feedback examples in the
 *  analyzer and score the targets against it. Stateless — examples and targets
 *  are sent per call, nothing is stored analyzer-side. Throws on non-2xx. */
export async function learnScoreBatch(
  examples: LearnExample[],
  targets: LearnTarget[],
): Promise<LearnScoreBatchResult> {
  const response = await fetch(`${ANALYZER_BASE_URL}/v1/learn/score-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ examples, targets }),
  });
  if (!response.ok) {
    throw new Error(
      `Analyzer /v1/learn/score-batch failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as LearnScoreBatchResult;
}

/** Company intel via the Hermes agent (spec F8). Only the company name is sent —
 *  this function takes no profile or job data by design. Throws on non-2xx. */
export async function analyzeCompany(companyName: string): Promise<CompanyIntel> {
  const response = await fetch(`${ANALYZER_BASE_URL}/v1/analyze/company`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ companyName }),
  });
  if (!response.ok) {
    throw new Error(
      `Analyzer /v1/analyze/company failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { intel: CompanyIntel };
  return body.intel;
}
