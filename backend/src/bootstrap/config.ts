const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3005',
  'http://localhost:5173',
];

export interface AppConfig {
  /**
   * Left as `string | number` because that is what `process.env.PORT || 4000`
   * has always produced, and `server.listen` accepts both. Coercing it here
   * would change what a non-numeric `PORT` does — today it reaches `listen` as
   * a string, which Node treats as a pipe path — and this refactor is meant to
   * move code, not alter startup behaviour.
   */
  port: string | number;
  corsOrigins: string[];
}

/**
 * The environment this process was started with, read once.
 *
 * Deliberately narrow: only the values the composition root needs to wire
 * things together. Everything else still reads `process.env` where it is used.
 * Pulling those in — with a schema, fail-fast validation and coercion — is its
 * own piece of work, and folding it in here would bury a behavioural change
 * (startup that now refuses to boot on bad input) inside a structural refactor.
 */
export const createConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => ({
  port: env.PORT || 4000,
  corsOrigins: (env.CORS_ORIGINS ?? DEFAULT_CORS_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});
