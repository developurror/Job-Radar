import { describe, expect, it } from 'vitest';
import { redactSensitiveUrlParams } from '../src/redactSensitiveUrlParams.js';

describe('redactSensitiveUrlParams', () => {
  it('masks app_id and app_key values in an Adzuna-style URL', () => {
    const text =
      'request failed for https://api.adzuna.com/v1/api/jobs/ca/search/1?app_id=TESTID123&app_key=TESTKEY123&results_per_page=50';
    const redacted = redactSensitiveUrlParams(text);
    expect(redacted).toContain('app_id=***');
    expect(redacted).toContain('app_key=***');
    expect(redacted).not.toContain('TESTID123');
    expect(redacted).not.toContain('TESTKEY123');
    expect(redacted).toContain('results_per_page=50');
  });

  it.each([
    'api_key',
    'apikey',
    'access_token',
    'token',
    'secret',
    'password',
    'auth',
  ])('masks the %s parameter', (parameterName) => {
    const redacted = redactSensitiveUrlParams(
      `https://example.com/feed?${parameterName}=SENTINELVALUE&page=2`,
    );
    expect(redacted).toContain(`${parameterName}=***`);
    expect(redacted).not.toContain('SENTINELVALUE');
    expect(redacted).toContain('page=2');
  });

  it('matches sensitive parameter names case-insensitively', () => {
    const redacted = redactSensitiveUrlParams(
      'https://example.com/feed?APP_KEY=TESTKEY123&Token=TESTTOKEN456',
    );
    expect(redacted).toContain('APP_KEY=***');
    expect(redacted).toContain('Token=***');
    expect(redacted).not.toContain('TESTKEY123');
    expect(redacted).not.toContain('TESTTOKEN456');
  });

  it('leaves non-sensitive parameters untouched', () => {
    const text =
      'https://api.adzuna.com/v1/api/jobs/us/search/1?what=developer&where=remote&sort_by=date&max_days_old=7';
    expect(redactSensitiveUrlParams(text)).toBe(text);
  });

  it('returns text without URLs unchanged', () => {
    const text = 'Analyzer /v1/embed failed: 422 Unprocessable Entity';
    expect(redactSensitiveUrlParams(text)).toBe(text);
  });

  it('returns a URL without a query string unchanged', () => {
    const text = 'fetch failed for https://example.com/jobs/123 today';
    expect(redactSensitiveUrlParams(text)).toBe(text);
  });

  it('masks sensitive parameters in every URL in the text', () => {
    const text =
      'first https://a.example/x?token=FIRSTSECRET then https://b.example/y?app_key=SECONDSECRET end';
    const redacted = redactSensitiveUrlParams(text);
    expect(redacted).not.toContain('FIRSTSECRET');
    expect(redacted).not.toContain('SECONDSECRET');
    expect(redacted).toContain('token=***');
    expect(redacted).toContain('app_key=***');
  });

  it('keeps the fragment while masking the query value before it', () => {
    const redacted = redactSensitiveUrlParams(
      'https://example.com/callback?access_token=TESTTOKEN123#section',
    );
    expect(redacted).toBe('https://example.com/callback?access_token=***#section');
  });

  it('redacts a full Adzuna-style adapter error end to end', () => {
    const adapterError =
      'Adzuna API request failed: 404 for https://api.adzuna.com/v1/api/jobs/canada/search/1?app_id=TESTID123&app_key=TESTKEY123&results_per_page=50&sort_by=date&content-type=application%2Fjson&what=angular-developer — {"exception":"UNSUPPORTED_COUNTRY"}';
    const redacted = redactSensitiveUrlParams(adapterError);
    expect(redacted).toContain('app_id=***');
    expect(redacted).toContain('app_key=***');
    expect(redacted).not.toContain('TESTID123');
    expect(redacted).not.toContain('TESTKEY123');
    expect(redacted).toContain('what=angular-developer');
    expect(redacted).toContain('Adzuna API request failed: 404');
    expect(redacted).toContain('UNSUPPORTED_COUNTRY');
  });
});
