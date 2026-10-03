import { afterEach, describe, expect, it, vi } from 'vitest';
import { embedTexts } from '../src/analyzerClient.js';

/** Fetch stub that mimics the analyzer's /v1/embed validation (1–256 texts
 *  per request); records the size of every batch it receives. */
function stubEmbedFetch(receivedBatchSizes: number[]) {
  const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
    const requestBody = JSON.parse(init?.body ?? '{}') as { texts: string[] };
    receivedBatchSizes.push(requestBody.texts.length);
    if (requestBody.texts.length === 0 || requestBody.texts.length > 256) {
      return { ok: false, status: 422, text: async () => 'Unprocessable Entity' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        vectors: requestBody.texts.map((text) => [text.length]),
        model: 'test-model',
        dimensions: 1,
      }),
      text: async () => '',
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('embedTexts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('splits batches larger than the analyzer per-request limit', async () => {
    const receivedBatchSizes: number[] = [];
    stubEmbedFetch(receivedBatchSizes);
    const texts = Array.from({ length: 300 }, (_unused, index) => 'x'.repeat(index + 1));
    const result = await embedTexts(texts);
    expect(receivedBatchSizes).toEqual([256, 44]);
    expect(result.vectors).toHaveLength(300);
    expect(result.vectors[299]).toEqual([300]);
    expect(result.model).toBe('test-model');
  });

  it('sends one request at exactly the limit', async () => {
    const receivedBatchSizes: number[] = [];
    stubEmbedFetch(receivedBatchSizes);
    const result = await embedTexts(Array.from({ length: 256 }, () => 'text'));
    expect(receivedBatchSizes).toEqual([256]);
    expect(result.vectors).toHaveLength(256);
  });

  it('makes no request for an empty list', async () => {
    const receivedBatchSizes: number[] = [];
    const fetchMock = stubEmbedFetch(receivedBatchSizes);
    const result = await embedTexts([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.vectors).toEqual([]);
  });

  it('throws with the status when the analyzer rejects a batch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })),
    );
    await expect(embedTexts(['hello'])).rejects.toThrow('500');
  });
});
