/**
 * Query parameters whose values are credentials. Source APIs like Adzuna
 * only accept credentials as query parameters, so request URLs themselves
 * carry secrets — and those URLs end up inside error messages. Anything
 * that logs or stores an error string must pass it through
 * redactSensitiveUrlParams first: logs get screenshotted and shared, and
 * stored run errors are shown on the dashboard.
 */
const SENSITIVE_QUERY_PARAMETERS = new Set([
  'app_id',
  'app_key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'secret',
  'password',
  'auth',
]);

const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]]+/g;

/** Mask the sensitive query parameter values inside one URL, in place as text. */
function redactUrlParameterValues(urlText: string): string {
  const queryStart = urlText.indexOf('?');
  if (queryStart === -1) return urlText;
  const fragmentStart = urlText.indexOf('#', queryStart);
  const queryEnd = fragmentStart === -1 ? urlText.length : fragmentStart;
  const redactedQuery = urlText
    .slice(queryStart + 1, queryEnd)
    .split('&')
    .map((parameterPair) => {
      const equalsIndex = parameterPair.indexOf('=');
      if (equalsIndex === -1) return parameterPair;
      const parameterName = parameterPair.slice(0, equalsIndex);
      return SENSITIVE_QUERY_PARAMETERS.has(parameterName.toLowerCase())
        ? `${parameterName}=***`
        : parameterPair;
    })
    .join('&');
  return urlText.slice(0, queryStart + 1) + redactedQuery + urlText.slice(queryEnd);
}

/**
 * Mask credential values in every URL found in the text. Parameter names
 * are kept so logs stay useful (`app_key=***`); non-sensitive parameters
 * and URL-free text pass through untouched.
 */
export function redactSensitiveUrlParams(text: string): string {
  return text.replace(URL_PATTERN, redactUrlParameterValues);
}
