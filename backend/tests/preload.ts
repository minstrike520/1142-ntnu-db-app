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
