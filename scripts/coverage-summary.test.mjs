import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const parser = join(import.meta.dirname, "coverage-summary.mjs");

function parse(format, content) {
  const directory = mkdtempSync(join(tmpdir(), "near-chat-coverage-"));
  const file = join(directory, format === "lcov" ? "lcov.info" : "coverage.json");
  writeFileSync(file, content);
  const result = spawnSync(process.execPath, [parser, format, file], { encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  return { ...result, output: JSON.parse(result.stdout) };
}

const lcov = (metrics) => `TN:\nSF:src/example.ts\n${metrics}\nend_of_record\n`;

test("aggregates valid LCOV metrics and leaves absent branches unavailable", () => {
  const result = parse("lcov", lcov("LF:4\nLH:2\nFNF:2\nFNH:1"));
  assert.equal(result.status, 0);
  assert.deepEqual(result.output, {
    status: "success",
    lines: "50.0%",
    functions: "50.0%",
    branches: null,
  });
});

test("preserves a genuine zero-percent result", () => {
  const result = parse("vitest", JSON.stringify({
    total: {
      lines: { covered: 0, total: 4 },
      functions: { covered: 0, total: 2 },
      branches: { covered: 0, total: 3 },
    },
  }));
  assert.equal(result.status, 0);
  assert.equal(result.output.lines, "0.0%");
  assert.equal(result.output.functions, "0.0%");
  assert.equal(result.output.branches, "0.0%");
});

test("rejects incomplete or non-numeric LCOV metrics", () => {
  for (const metrics of [
    "LF:4\nFNF:2\nFNH:1",
    "LF:4\nLH:two\nFNF:2\nFNH:1",
    "LF:4\nLH:2\nFNF:2\nFNH:not-a-number",
    "LF:4\nLH:2\nFNF:2\nFNH:3",
  ]) {
    const result = parse("lcov", lcov(metrics));
    assert.equal(result.status, 1);
    assert.equal(result.output.status, "error");
  }
});

test("rejects null and incomplete Vitest metrics instead of coercing them to zero", () => {
  const result = parse("vitest", JSON.stringify({
    total: {
      lines: { covered: null, total: 4 },
      functions: { covered: 1, total: 2 },
    },
  }));
  assert.equal(result.status, 1);
  assert.equal(result.output.status, "error");
});

test("rejects a partially supplied optional branch metric", () => {
  const result = parse("vitest", JSON.stringify({
    total: {
      lines: { covered: 1, total: 2 },
      functions: { covered: 1, total: 2 },
      branches: { covered: 1 },
    },
  }));
  assert.equal(result.status, 1);
  assert.equal(result.output.status, "error");
});