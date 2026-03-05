# fix(ai): add endpoint cascade for 403/404 and autopush fallback

## Problem

When the daily sandbox endpoint returns 403 or 404, the request fails immediately instead of trying the next endpoint. Individual endpoints can go down or reject requests temporarily, and there's no fallback path.

## Root Cause

The retry loop only retries on 429 (rate limit) and 5xx (server errors). 403 and 404 from one endpoint don't trigger a cascade to the next. Additionally, the `autopush-cloudcode-pa.sandbox` endpoint (used by the reference implementations) was missing from the fallback list.

The [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) reference implementation handles this explicitly:

```typescript
// src/plugin.ts:2275-2281
const shouldRetryEndpoint = (
  response.status === 403 ||
  response.status === 404 ||
  response.status >= 500
);

if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
  continue;
}
```

And defines three endpoints ([`src/constants.ts:32-44`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/constants.ts)):
```typescript
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = [
  ANTIGRAVITY_ENDPOINT_DAILY,     // daily-cloudcode-pa.sandbox
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,  // autopush-cloudcode-pa.sandbox
  ANTIGRAVITY_ENDPOINT_PROD,      // cloudcode-pa
] as const;
```

## Fix

- Add `autopush-cloudcode-pa.sandbox.googleapis.com` to the endpoint fallback list (daily → autopush → prod)
- Add `isEndpointRetryable()` that treats 403, 404, and 5xx as endpoint-retryable
- On endpoint-retryable errors, cascade to the next endpoint instead of throwing immediately
- Rate-limit errors (429) still get exponential backoff as before

## Testing

- ✅ Biome lint clean
- ✅ TypeScript typecheck clean
- No existing upstream test file for `google-gemini-cli.ts`
