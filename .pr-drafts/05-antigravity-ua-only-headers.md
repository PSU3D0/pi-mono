# fix(ai): reduce antigravity fingerprint to User-Agent only

## Problem

Antigravity requests include `X-Goog-Api-Client` and `Client-Metadata` HTTP headers that increase the fingerprint surface area and don't match actual Antigravity Manager client behavior.

## Root Cause

The [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) reference implementation documents that the Antigravity Manager only sends `User-Agent` on content requests:

```typescript
// src/plugin/request.ts:1544
// AM only sends User-Agent on content requests — no X-Goog-Api-Client, no Client-Metadata header
// (ideType=ANTIGRAVITY goes in request body metadata via project.ts, not as a header)
```

`X-Goog-Api-Client` and `Client-Metadata` are only used in Gemini CLI (non-antigravity) mode ([`src/plugin/request.ts:1553-1554`](https://github.com/NoeFabris/opencode-antigravity-auth/blob/main/src/plugin/request.ts)).

## Fix

Remove `X-Goog-Api-Client` and `Client-Metadata` from `getAntigravityHeaders()`, keeping only `User-Agent`.

## Testing

- ✅ Biome lint clean
- ✅ TypeScript typecheck clean
- No existing upstream test file for `google-gemini-cli.ts`
