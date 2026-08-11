// Bun test preload (configured in bunfig.toml).
//
// Points app code that reads DATABASE_URL at the dedicated test database.
// Native replacement for the deleted vitest setupFiles hook.
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

// Set CORS_ORIGINS before the first E2E file imports src/index.
//
// Assigned unconditionally, not with `??`: the CORS E2E case asserts against
// this exact allowlist, so the suite has to own the variable. Deferring to an
// inherited value made the test fail for anyone who had CORS_ORIGINS exported
// — which `.env.example` ships and every docker-compose developer therefore
// has — with a bare "expected http://allowed.example, received undefined"
// that points at the app rather than at the environment.
process.env.CORS_ORIGINS = 'http://allowed.example,http://localhost:3005';
