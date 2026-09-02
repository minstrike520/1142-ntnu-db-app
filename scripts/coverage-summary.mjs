import { readFileSync } from "node:fs";

const [format, file] = process.argv.slice(2);

const percent = (covered, total) => `${((covered / total) * 100).toFixed(1)}%`;

const validateMetric = (name, covered, total, { optional = false } = {}) => {
  if (covered === null && total === null) {
    if (optional) return null;
    throw new Error(`${name} coverage is missing covered and total counts`);
  }
  if (covered === null || total === null) {
    throw new Error(`${name} coverage is missing either covered or total count`);
  }
  if (!Number.isFinite(covered) || !Number.isFinite(total) || covered < 0 || total < 0) {
    throw new Error(`${name} coverage counts must be finite and non-negative`);
  }
  if (covered > total) {
    throw new Error(`${name} coverage has covered count greater than total count`);
  }
  // A zero-sized optional metric means the coverage source did not provide a
  // meaningful denominator (for example, a file with no branch points).
  if (total === 0) {
    if (optional && covered === 0) return null;
    throw new Error(`${name} coverage total must be greater than zero`);
  }
  return percent(covered, total);
};

const parseLcovCount = (name, raw) => {
  const value = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
    throw new Error(`LCOV ${name} count must be a non-negative integer`);
  }
  return value;
};

const parseLcov = (content) => {
  const totals = {
    lines: { covered: null, total: null },
    functions: { covered: null, total: null },
    branches: { covered: null, total: null },
  };

  for (const line of content.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const target = {
      LF: ["lines", "total"],
      LH: ["lines", "covered"],
      FNF: ["functions", "total"],
      FNH: ["functions", "covered"],
      BRF: ["branches", "total"],
      BRH: ["branches", "covered"],
    }[key];
    if (!target) continue;
    const [metricName, field] = target;
    const value = parseLcovCount(key, line.slice(separator + 1));
    totals[metricName][field] = (totals[metricName][field] ?? 0) + value;
  }

  return {
    status: "success",
    lines: validateMetric("line", totals.lines.covered, totals.lines.total),
    functions: validateMetric("function", totals.functions.covered, totals.functions.total),
    branches: validateMetric("branch", totals.branches.covered, totals.branches.total, { optional: true }),
  };
};

const parseVitest = (content) => {
  const total = JSON.parse(content).total;
  if (!total || typeof total !== "object") {
    throw new Error("Vitest coverage summary is missing the total metrics");
  }

  const readMetric = (name, { optional = false } = {}) => {
    const value = total[name];
    if (value === undefined) {
      if (optional) return null;
      throw new Error(`Vitest coverage is missing the ${name} metric`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Vitest ${name} coverage metric is invalid`);
    }
    const covered = Object.hasOwn(value, "covered") ? value.covered : null;
    const metricTotal = Object.hasOwn(value, "total") ? value.total : null;
    if ((covered !== null && typeof covered !== "number") ||
        (metricTotal !== null && typeof metricTotal !== "number")) {
      throw new Error(`Vitest ${name} coverage counts must be numbers`);
    }
    return validateMetric(name, covered, metricTotal, { optional });
  };

  const lines = readMetric("lines");
  const functions = readMetric("functions");

  return {
    status: "success",
    lines,
    functions,
    branches: readMetric("branches", { optional: true }),
  };
};

let summary;
try {
  if (!format || !file) throw new Error("usage: coverage-summary.mjs <lcov|vitest> <file>");
  const content = readFileSync(file, "utf8");
  summary = format === "lcov" ? parseLcov(content) : format === "vitest" ? parseVitest(content) : null;
  if (!summary) throw new Error(`unsupported coverage format: ${format}`);
} catch (error) {
  summary = {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
  process.exitCode = 1;
}

console.log(JSON.stringify(summary));
