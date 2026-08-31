#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Holds the production Compose models to a checked-in property contract.
 *
 * Deliberately not "render both files and diff them field by field, with an
 * allowlist for the differences". `docker-compose.prod.yml` and
 * `docker-compose.release.yml` are two products, not two renders of one system:
 * prod builds from source, fronts everything with cloudflared and applies
 * migrations by hand, while release runs pinned images and a dedicated
 * `migrate` service. Almost every field would land in the allowlist, and an
 * allowlist that large is indistinguishable from having no check at all.
 *
 * So each model is asserted against its own rows in `compose-invariants.json`.
 * Every row carries the reason it is load-bearing, because the value alone
 * never says why it may not change.
 */

const PROJECT_NAME = "near-chat";

export const MODELS = {
  prod: "docker-compose.prod.yml",
  release: "docker-compose.release.yml",
};

/**
 * Rendered with `--no-interpolate`, which is what makes this check reproducible
 * *and* able to see the policy layer at all:
 *
 * - No value is fabricated. `docker compose config` on the release model exits
 *   1 without eight real secrets; feeding it synthetic ones would assert the
 *   fixture rather than the file.
 * - The result cannot depend on an ambient `.env`, a developer's shell, or a CI
 *   secret. It is a pure function of the checked-in YAML.
 * - `${VAR:?}` / `${VAR:-}` / `${VAR-}` and `$${...}` survive as text, so the
 *   fail-fast policy and the escaping are assertable instead of resolved away.
 *
 * Compose still normalizes structure in this mode -- short port strings become
 * records, `depends_on` becomes conditions -- so the structural invariants are
 * read off the same render.
 *
 * `--env-file /dev/null` is belt and braces on the first point;
 * `--no-path-resolution` keeps `build.context` from becoming the absolute path
 * of whatever directory this happens to run in; `-p` fixes the project name,
 * which prod otherwise inherits from the checkout directory name.
 */
function renderModel(rootDirectory, file) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      PROJECT_NAME,
      "--env-file",
      "/dev/null",
      "-f",
      file,
      "config",
      // Both of these are flags of `config`, not global flags: as global flags
      // Compose exits 1 with "unknown flag".
      "--no-interpolate",
      "--no-path-resolution",
      "--format",
      "json",
    ],
    { cwd: rootDirectory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.error) {
    throw new Error(`could not run docker compose for ${file}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`docker compose config failed for ${file}:\n${(result.stderr || "").trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`docker compose config emitted unparseable JSON for ${file}: ${error.message}`);
  }
}

/**
 * Compose accepts environment as a map or as a list, and `--no-interpolate`
 * does not converge the two: prod uses the list form and release the map form,
 * so without this every prod env row would have to be written as a string match
 * against a list entry.
 *
 * The unset/empty distinction is preserved rather than normalized away. `FOO`
 * (no `=`) means "pass whatever the host has, if anything" and reaches the
 * container absent; `FOO=` means "set, empty". docker-compose.prod.yml relies on
 * exactly that difference for LOG_LEVEL and INSTANCE_ID, so collapsing them
 * would make those rows vacuous.
 */
function normalizeEnvironment(environment) {
  if (!Array.isArray(environment)) return environment ?? undefined;
  const normalized = {};
  for (const entry of environment) {
    if (typeof entry !== "string") continue;
    const separator = entry.indexOf("=");
    if (separator < 0) {
      normalized[entry] = null;
      continue;
    }
    normalized[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return normalized;
}

/**
 * A published port with no `host_ip` binds every interface. Compose emits the
 * key only when the file names one, so prod's loopback-only binding and
 * release's public binding differ by key *presence* in the raw render -- the
 * single most security-relevant difference between the two files, reduced to
 * something a reader would take for a formatting artifact. Defaulting it here
 * turns it back into a value difference that a contract row can state.
 *
 * `published` is a string and `target` an integer in Compose's own output;
 * pinning both keeps a row from passing or failing on JSON number/string
 * coercion rather than on the port.
 */
function normalizePorts(ports) {
  if (!Array.isArray(ports)) return ports;
  return ports.map((port) => ({
    ...port,
    host_ip: port.host_ip ?? "0.0.0.0",
    published: port.published === undefined ? undefined : String(port.published),
    target: port.target === undefined ? undefined : Number(port.target),
  }));
}

/**
 * Compose emits `read_only` only when the mount asks for it, so a writable
 * mount and a read-only one differ by key presence -- the same trap as
 * `host_ip`. A subset match lists only the keys it cares about, so without
 * this a `:ro` suffix keeps `type`, `source` and `target` identical and slips
 * through, taking Postgres down at boot (it must write to its data directory)
 * and silently failing every upload.
 */
function normalizeMounts(mounts) {
  if (!Array.isArray(mounts)) return mounts;
  return mounts.map((mount) => ({ ...mount, read_only: mount.read_only ?? false }));
}

/**
 * Compose injects `networks: {default: null}` into every service and `command`
 * / `entrypoint` as null where the file sets neither. Those are artifacts of
 * the render, not of the file, so they are reduced to the attachment list and
 * dropped respectively -- otherwise a contract row on `command` could not tell
 * "the file sets no command" from "the file sets a null command".
 */
function normalizeService(service) {
  const normalized = { ...service };

  if (normalized.networks && typeof normalized.networks === "object" && !Array.isArray(normalized.networks)) {
    normalized.networks = Object.keys(normalized.networks).sort();
  }
  for (const key of ["command", "entrypoint"]) {
    if (normalized[key] === null) delete normalized[key];
  }
  if (normalized.environment !== undefined) {
    normalized.environment = normalizeEnvironment(normalized.environment);
  }
  if (normalized.ports !== undefined) {
    normalized.ports = normalizePorts(normalized.ports);
  }
  if (normalized.volumes !== undefined) {
    normalized.volumes = normalizeMounts(normalized.volumes);
  }
  return normalized;
}

/**
 * `internal` is the third key Compose emits only when asked, after `host_ip`
 * and `read_only`. An internal network is externally isolated, so cloudflared
 * -- the only ingress -- cannot dial out to Cloudflare and the whole site goes
 * offline, while the network still exists, is still named `default`, and every
 * service is still attached to it.
 */
function normalizeNetworks(networks) {
  if (!networks || typeof networks !== "object") return networks;
  return Object.fromEntries(
    Object.entries(networks).map(([name, network]) => [
      name,
      network && typeof network === "object" ? { ...network, internal: network.internal ?? false } : network,
    ]),
  );
}

export function normalizeModel(model) {
  const services = {};
  for (const [name, service] of Object.entries(model.services ?? {})) {
    services[name] = normalizeService(service ?? {});
  }
  const normalized = { ...model, services };
  if (normalized.networks !== undefined) {
    normalized.networks = normalizeNetworks(normalized.networks);
  }
  return normalized;
}

/** `services.backend.ports[0].host_ip` -> the value, or MISSING. */
const MISSING = Symbol("missing");

/**
 * A `*` segment fans out over every key (or element) at that point and collects
 * the rest of the path from each. `services.*.networks` is then one row that
 * covers every service, including services added later -- which is the point
 * for topology rules, where the risk is a *new* service wired up wrongly rather
 * than an existing one being edited.
 *
 * A branch that does not resolve collects MISSING rather than being dropped, so
 * "every service is on the default network" fails for a service that is on no
 * network at all instead of quietly skipping it.
 */
function walk(current, segments) {
  if (segments.length === 0) return current;
  const [segment, ...rest] = segments;
  if (current === null || current === undefined) return MISSING;

  if (segment === "*") {
    if (Array.isArray(current)) return current.map((value) => walk(value, rest));
    if (typeof current !== "object") return MISSING;
    return Object.keys(current)
      .sort()
      .map((key) => walk(current[key], rest));
  }
  if (Array.isArray(current)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0 || index >= current.length) return MISSING;
    return walk(current[index], rest);
  }
  if (typeof current !== "object") return MISSING;
  if (!Object.prototype.hasOwnProperty.call(current, segment)) return MISSING;
  return walk(current[segment], rest);
}

function readPath(root, path) {
  return walk(
    root,
    path
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .filter((segment) => segment.length > 0),
  );
}

/**
 * The reported `actual` has to be readable next to `expect`, or the failure is
 * a wall of JSON nobody reads. A `$keys` row is answered with the key list
 * rather than the whole subtree it came from, and anything still oversized is
 * truncated -- the path in the message is enough to go look at the rest.
 */
function describe(value, expected) {
  if (value === MISSING) return "<missing>";
  const subject =
    expected !== null && typeof expected === "object" && !Array.isArray(expected) && "$keys" in expected && value && typeof value === "object"
      ? Object.keys(value).sort()
      : value;
  // A `*` fan-out can collect MISSING for a branch that does not resolve, and
  // JSON.stringify renders a symbol in an array as null -- which reads as "the
  // value is null" rather than "this service has none".
  const rendered = JSON.stringify(subject, (_key, value) => (value === MISSING ? "<missing>" : value));
  return rendered.length > 400 ? `${rendered.slice(0, 400)}... (truncated)` : rendered;
}

/**
 * Compared on a key-sorted rendering rather than raw JSON.stringify: Compose
 * does not promise a stable key order, and already varies it between render
 * modes. Array order is preserved, because for `healthcheck.test` and
 * `command` it is the meaning.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function deepEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** Does one array element carry all of the subset's key/values? */
function matchesSubset(subset, element) {
  if (element === null || typeof element !== "object") return false;
  return Object.entries(subset).every(([key, value]) => deepEqual(value, element[key]));
}

/**
 * `expect` is a literal to deep-equal, or one of five operators. Kept this
 * small on purpose: a contract that can express arbitrary predicates stops
 * being readable as a statement of what production looks like.
 *
 * `$every` and `$contains` exist because indexing a single element is not a
 * statement about a list. `ports[0].host_ip` says nothing about a *second*
 * port added after it, and a second published port is precisely how a service
 * ends up on 0.0.0.0 while the contract still passes.
 */
function matches(expected, actual) {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if ("$absent" in expected) {
      return expected.$absent === (actual === MISSING);
    }
    if ("$matches" in expected) {
      return typeof actual === "string" && new RegExp(expected.$matches).test(actual);
    }
    if ("$keys" in expected) {
      if (actual === MISSING || actual === null || typeof actual !== "object") return false;
      return deepEqual(expected.$keys, Object.keys(actual).sort());
    }
    if ("$every" in expected) {
      // Non-empty on purpose: an empty list satisfies "every element is
      // loopback" vacuously, which is not what the row is claiming.
      if (!Array.isArray(actual) || actual.length === 0) return false;
      // A plain object matches each element as a subset (one port among its
      // other fields); anything else is compared whole, which is what a `*`
      // fan-out collecting whole values needs.
      const subset = expected.$every !== null && typeof expected.$every === "object" && !Array.isArray(expected.$every);
      return actual.every((element) =>
        subset ? matchesSubset(expected.$every, element) : deepEqual(expected.$every, element),
      );
    }
    if ("$contains" in expected) {
      if (!Array.isArray(actual)) return false;
      return actual.some((element) => matchesSubset(expected.$contains, element));
    }
  }
  return actual !== MISSING && deepEqual(expected, actual);
}

export function evaluate(rootDirectory, render = renderModel) {
  const contractPath = resolve(rootDirectory, "compose-invariants.json");
  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, "utf8"));
  } catch (error) {
    return [`could not read compose-invariants.json: ${error.message}`];
  }

  const rows = contract.invariants;
  if (!Array.isArray(rows) || rows.length === 0) {
    return ["compose-invariants.json has no `invariants` rows"];
  }

  const failures = [];
  const models = {};
  /** model key -> services named by at least one row; see the coverage rule below. */
  const covered = {};

  for (const [key, file] of Object.entries(MODELS)) {
    let model;
    try {
      model = normalizeModel(render(rootDirectory, file));
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    // Mirrors the guard in backend/tests/unit/deploy/releaseComposeRuntime.test.ts:
    // a rename that empties the model must fail loudly rather than vacuously
    // satisfying every row that asserts something is absent.
    if (Object.keys(model.services).length === 0) {
      failures.push(`${file} rendered no services; the contract below would be vacuous`);
      continue;
    }
    models[key] = model;
  }

  for (const [index, row] of rows.entries()) {
    const label = `compose-invariants.json[${index}]`;
    if (!row || typeof row !== "object") {
      failures.push(`${label}: row is not an object`);
      continue;
    }
    const { model: modelKey, path, expect: expected, why } = row;
    // hasOwnProperty rather than truthiness: `MODELS.constructor` is inherited
    // and truthy, and would then be used as a filename.
    if (typeof modelKey !== "string" || !Object.prototype.hasOwnProperty.call(MODELS, modelKey)) {
      failures.push(`${label}: unknown model ${JSON.stringify(modelKey)}; expected one of ${Object.keys(MODELS).join(", ")}`);
      continue;
    }
    if (typeof path !== "string" || path.length === 0) {
      failures.push(`${label}: missing \`path\``);
      continue;
    }
    // The reason is as load-bearing as the value. A row that cannot say why it
    // exists cannot be reviewed when it fails, and is the first thing someone
    // deletes instead of investigating.
    if (typeof why !== "string" || !/#\d+/.test(why)) {
      failures.push(`${MODELS[modelKey]} ${path}: \`why\` must cite the issue that made this load-bearing`);
      continue;
    }
    if (expected === undefined) {
      failures.push(`${label}: missing \`expect\``);
      continue;
    }

    const model = models[modelKey];
    // Its model failed to render; that is already reported, and re-reporting
    // every row against it would bury the one failure that matters.
    if (!model) continue;

    // A `*` row deliberately does NOT count toward coverage. It governs every
    // service by construction, so letting it satisfy the rule would mean a new
    // service could be added with only the blanket topology row applying to it
    // -- which is exactly the "slipped in ungoverned" case coverage exists for.
    const service = /^services\.([^.[]+)/.exec(path)?.[1];
    if (service && service !== "*") (covered[modelKey] ??= new Set()).add(service);

    const actual = readPath(model, path);
    if (!matches(expected, actual)) {
      failures.push(
        `${MODELS[modelKey]} ${path}\n    expect: ${JSON.stringify(expected)}\n    actual: ${describe(actual, expected)}\n    why:    ${why}`,
      );
    }
  }

  // "Every row resolves" only catches a row being left behind. It says nothing
  // about the direction that actually matters: a service added to a production
  // model with nothing in the contract governing it -- a new port, a new image,
  // a new mount -- would pass a contract it is simply absent from. Requiring
  // every rendered service to be named by at least one row makes adding one a
  // deliberate act with a stated reason, rather than something that slips in.
  for (const [key, model] of Object.entries(models)) {
    for (const service of Object.keys(model.services)) {
      if (covered[key]?.has(service)) continue;
      failures.push(
        `${MODELS[key]} services.${service} is not named by any row in compose-invariants.json; add the rows that govern it`,
      );
    }
  }

  return failures;
}

function check(rootDirectory) {
  const failures = evaluate(rootDirectory);
  if (failures.length) {
    console.error("Compose invariant contract failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log("Compose invariant contract passed: both production models match compose-invariants.json");
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = check(process.cwd());
  } catch (error) {
    console.error(`Compose invariant contract failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
