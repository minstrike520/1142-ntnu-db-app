// Bun test preload (configured in bunfig.toml).
//
// Points app code that reads DATABASE_URL at the dedicated test database.
// Native replacement for the deleted vitest setupFiles hook
// (tests/helpers/setup.ts) — this is runner bootstrap config, not a mocking
// or polling shim, so it does not reintroduce the Jest compatibility layer
// that issue #316 removes.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

// src/index.ts reads CORS_ORIGINS once at module-eval time. Bun shares one
// module registry across all test files, so the app is evaluated only once —
// its CORS allow-list must therefore be set before the first e2e file imports
// src/index. Setting it here makes it deterministic regardless of file order.
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? 'http://allowed.example,http://localhost:3005';
