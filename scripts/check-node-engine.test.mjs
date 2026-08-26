import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { evaluate } from "./check-node-engine.mjs";

const guard = join(import.meta.dirname, "check-node-engine.mjs");

function runGuard({
  rootRange = "^22.22.2 || ^24.15.0 || >=26.0.0",
  lockRange,
  extraPackages = "",
}) {
  const directory = mkdtempSync(join(tmpdir(), "near-chat-node-engine-"));
  const packageJson = {
    name: "fixture",
    private: true,
    engines: { node: rootRange },
  };
  const lockfile = `lockfileVersion: '9.0'

importers:

  .: {}

packages:

  left-pad@1.3.0:
    engines: {node: '>=6'}

  jsdom@30.0.1:
    engines: {node: ${JSON.stringify(lockRange)}}

${extraPackages}

snapshots:

  jsdom@30.0.1: {}
`;
  writeFileSync(join(directory, "package.json"), `${JSON.stringify(packageJson)}\n`);
  writeFileSync(join(directory, "pnpm-lock.yaml"), lockfile);
  const result = spawnSync(process.execPath, [guard], {
    cwd: directory,
    encoding: "utf8",
  });
  // The managed local runner disallows child processes (EPERM). Keep the
  // normal assertion at the CLI seam, with a direct evaluation fallback for
  // that runner; CI executes the actual command.
  const normalizedResult = (() => {
    if (result.error) {
      const failures = evaluate(directory);
      return { ...result, status: failures.length ? 1 : 0, stderr: failures.join("\n") };
    }
    return result;
  })();
  rmSync(directory, { recursive: true, force: true });
  return normalizedResult;
}

test("accepts the checked-in Node policy", () => {
  const result = runGuard({
    lockRange: "^22.22.2 || ^24.15.0 || >=26.0.0",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("compares semver sets instead of requiring identical range strings", () => {
  const result = runGuard({
    rootRange: ">=22.22.2 <23 || >=24.15.0 <25 || >=26",
    lockRange: "^22.22.2 || ^24.15.0 || >=26.0.0",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rejects an over-broad root engine range and names jsdom", () => {
  const result = runGuard({ rootRange: ">=20", lockRange: "^22.22.2 || ^24.15.0 || >=26.0.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /jsdom/);
  assert.match(result.stderr, /\^22\.22\.2 \|\| \^24\.15\.0 \|\| >=26\.0\.0/);
});

test("rejects an over-strict root engine range", () => {
  const result = runGuard({ rootRange: ">=26", lockRange: "^22.22.2 || ^24.15.0 || >=26.0.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /excludes|strict|supported/i);
});

test("reports an actionable lockfile floor drift", () => {
  const result = runGuard({ lockRange: "^22.22.3 || ^24.15.0 || >=26.0.0" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /floor|range drift/i);
  assert.match(result.stderr, /jsdom/);
  assert.match(result.stderr, /Set it to \^22\.22\.3/);
});

test("derives an intersection contributed by more than one package", () => {
  const result = runGuard({
    rootRange: ">=22 <24",
    lockRange: ">=20 <24",
    extraPackages: `  tool@1.0.0:\n    engines: {node: '>=22'}`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("ignores optional artifacts for another operating system and CPU", () => {
  const result = runGuard({
    lockRange: "^22.22.2 || ^24.15.0 || >=26.0.0",
    extraPackages: `  optional-win32-ia32@1.0.0:\n    engines: {node: '^20.9.0'}\n    os: [win32]\n    cpu: [ia32]`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("ignores optional artifacts for another Linux libc", () => {
  const result = runGuard({
    lockRange: "^22.22.2 || ^24.15.0 || >=26.0.0",
    extraPackages: `  optional-musl@1.0.0:\n    engines: {node: '^20.9.0'}\n    os: [linux]\n    libc: [musl]`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
