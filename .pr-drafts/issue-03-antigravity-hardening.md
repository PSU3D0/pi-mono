---
title: "Antigravity auth: 403s from stale headers, missing endpoint fallbacks, extra fingerprint headers"
labels: bug, pkg:ai
---

Spent some time comparing pi's antigravity implementation against [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) and found three issues that cause reliability problems. Each is small and independent.

### 1. `x-goog-user-project` header causes 403

This header gets injected by the Google Auth library and triggers project-level IAM checks that fail for OAuth-based antigravity requests. The opencode reference explicitly strips it ([`request.ts:791-794`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/plugin/request.ts)):

```typescript
// Strip x-goog-user-project header to prevent 403 auth/license conflicts.
headers.delete("x-goog-user-project");
```

Fix: +10 lines — `stripProblematicHeaders()` after header merge.

### 2. No endpoint cascade on 403/404

When the daily sandbox endpoint returns 403 or 404, pi throws immediately instead of trying the next endpoint. The opencode reference cascades across three endpoints on 403/404/5xx ([`plugin.ts:2275-2281`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/plugin.ts)):

```typescript
const shouldRetryEndpoint = (
  response.status === 403 || response.status === 404 || response.status >= 500
);
if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
  continue;
}
```

pi is also missing the `autopush-cloudcode-pa.sandbox` endpoint from the fallback list ([`constants.ts:40-44`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/constants.ts)).

Fix: +19 lines — `isEndpointRetryable()` + add autopush endpoint.

### 3. Extra fingerprint headers

`getAntigravityHeaders()` sends `X-Goog-Api-Client` and `Client-Metadata` as HTTP headers, but the Antigravity Manager only sends `User-Agent` on content requests. The opencode reference notes this explicitly ([`request.ts:1544`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/plugin/request.ts)):

```
// AM only sends User-Agent on content requests — no X-Goog-Api-Client, no Client-Metadata header
```

Those extra headers are only used in Gemini CLI (non-antigravity) mode.

Fix: -3 lines — remove two headers from `getAntigravityHeaders()`.

---

I have each fix on a separate branch for easy review:
- [`fix/antigravity-strip-project-header`](https://github.com/PSU3D0/pi-mono/tree/fix/antigravity-strip-project-header)
- [`fix/antigravity-endpoint-cascade`](https://github.com/PSU3D0/pi-mono/tree/fix/antigravity-endpoint-cascade)
- [`fix/antigravity-ua-only-headers`](https://github.com/PSU3D0/pi-mono/tree/fix/antigravity-ua-only-headers)

Happy to submit as one PR or three, whatever's easier to review.
