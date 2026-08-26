#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import semver from "semver";

// Keep the reason for engines.node executable here instead of beside the
// manifest value: prose drifts, while this check is rerun whenever the
// dependency graph or its policy changes.
function selectorAllows(selectors, value) {
  if (!Array.isArray(selectors) || selectors.length === 0) return true;
  if (selectors.includes(`!${value}`)) return false;
  const positive = selectors.filter((selector) => !selector.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
}

function runtimeLibc() {
  if (process.platform !== "linux") return undefined;
  return process.report?.getReport?.().header?.glibcVersionRuntime ? "glibc" : "musl";
}

function packageRecords(lockfile) {
  const environment = {
    os: process.platform,
    cpu: process.arch,
    libc: runtimeLibc(),
  };
  return ["packages", "snapshots", "importers"].flatMap((section) =>
    Object.entries(lockfile[section] ?? {}).flatMap(([identity, value]) => {
      // One pnpm lockfile includes optional artifacts for every platform. An
      // artifact only constrains this install when all of its selectors match.
      if (
        !selectorAllows(value?.os, environment.os) ||
        !selectorAllows(value?.cpu, environment.cpu) ||
        (environment.libc !== undefined && !selectorAllows(value?.libc, environment.libc))
      ) return [];
      const engine = value?.engines?.node;
      return typeof engine === "string" || typeof engine === "number"
        ? [{ section, identity, engine: String(engine) }]
        : [];
    }),
  );
}

function intersectRanges(ranges) {
  let sets = [[]];
  for (const range of ranges) {
    const parsed = new semver.Range(range);
    let next = [];
    for (const left of sets) {
      for (const right of parsed.set) {
        const comparators = [...left, ...right];
        const candidate = comparators.map(String).join(" ");
        const normalized = new semver.Range(candidate);
        if (!semver.minVersion(normalized)) continue;
        const candidateSet = normalized.set[0];
        const candidateRange = candidateSet.map(String).join(" ");
        // A broader clause covers any contained clause. Pruning here prevents
        // repeated union ranges from growing the cartesian product without
        // changing the resulting set of supported versions.
        if (next.some((set) => semver.subset(candidateRange, set.map(String).join(" ")))) continue;
        next = next.filter((set) => !semver.subset(set.map(String).join(" "), candidateRange));
        next = [...next, candidateSet];
      }
    }
    sets = next;
  }
  if (sets.length === 0) return null;
  return new semver.Range(sets.map((set) => set.map(String).join(" ")).join(" || "));
}

function equivalent(left, right) {
  return semver.subset(left, right) && semver.subset(right, left);
}

function rangeSuggestion(intersection, records) {
  const candidate = records.find((record) => equivalent(record.engine, intersection.range));
  return candidate?.engine ?? intersection.range;
}

export function evaluate(rootDirectory) {
  const packagePath = resolve(rootDirectory, "package.json");
  const lockfilePath = resolve(rootDirectory, "pnpm-lock.yaml");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const rootRange = packageJson.engines?.node;
  const lockRecords = packageRecords(parseYaml(readFileSync(lockfilePath, "utf8")));
  const inputFailures = [
    ...(typeof rootRange !== "string" || !rootRange.trim() ? ["package.json is missing engines.node"] : []),
    ...(lockRecords.length === 0 ? ["pnpm-lock.yaml has no package engines.node entries; refresh the lockfile with pnpm install"] : []),
  ];
  if (inputFailures.length) return inputFailures;

  let intersection;
  try {
    intersection = intersectRanges(lockRecords.map((record) => record.engine));
  } catch (error) {
    return [`invalid package engines.node range: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!intersection) {
    return ["package engines.node ranges have no semver intersection; inspect pnpm-lock.yaml"];
  }

  const suggestion = rangeSuggestion(intersection, lockRecords);
  try {
    if (equivalent(rootRange, intersection.range)) return [];
    if (semver.subset(intersection.range, rootRange)) {
      const narrowing = lockRecords.find((record) => !semver.subset(rootRange, record.engine));
      const rootFloor = semver.minVersion(rootRange)?.version;
      const lockFloor = semver.minVersion(intersection.range)?.version;
      const floor = rootFloor !== lockFloor ? " This is a Node engine floor drift." : "";
      return [`package.json engines.node (${rootRange}) is over-broad; ${narrowing?.identity ?? "the lockfile"} narrows the supported Node range.${floor} Set it to ${suggestion}.`];
    }
    if (semver.subset(rootRange, intersection.range)) {
      return [`package.json engines.node (${rootRange}) is over-strict and excludes supported Node versions from the lockfile intersection. Set it to ${suggestion}.`];
    }
    return [`package.json engines.node (${rootRange}) does not match the lockfile Node intersection. Update package.json and pnpm-lock.yaml to ${suggestion}.`];
  } catch (error) {
    return [`invalid package.json engines.node range: ${error instanceof Error ? error.message : String(error)}`];
  }
}

function check(rootDirectory) {
  const failures = evaluate(rootDirectory);
  if (failures.length) {
    console.error("Node engine guard failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log("Node engine guard passed: package.json matches the pnpm-lock.yaml engine intersection");
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = check(process.cwd());
  } catch (error) {
    console.error(`Node engine guard failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
