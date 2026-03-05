# fix(ai): strip x-goog-user-project header from antigravity requests

## Problem

Antigravity requests intermittently fail with **403** when the `x-goog-user-project` header is present. This header triggers project-level IAM permission checks that conflict with the OAuth-based Antigravity auth flow, which doesn't use project-scoped credentials.

## Root Cause

The header can be injected by the AI SDK, Google Auth library, or application-level middleware. The [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) reference implementation explicitly strips it:

```typescript
// src/plugin/request.ts:791-794
// Strip x-goog-user-project header to prevent 403 auth/license conflicts.
// This header is added by OpenCode/AI SDK and can force project-level checks
// that are not required for Antigravity/Gemini CLI OAuth requests.
headers.delete("x-goog-user-project");
```

## Fix

Add `stripProblematicHeaders()` that deletes `x-goog-user-project` (both casings) from the request headers before sending. Called after all headers are merged so it catches headers from any source.

## Testing

- ✅ Biome lint clean
- ✅ TypeScript typecheck clean
- No existing upstream test file for `google-gemini-cli.ts`
