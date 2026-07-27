// Bun test preload (configured in bunfig.toml).
//
// Points app code that reads DATABASE_URL at the dedicated test database.
// Native replacement for the deleted vitest setupFiles hook.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

// Set CORS_ORIGINS before the first E2E file imports src/index.
process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? 'http://allowed.example,http://localhost:3005';
