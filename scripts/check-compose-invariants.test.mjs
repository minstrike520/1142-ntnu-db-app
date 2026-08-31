import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { evaluate, normalizeModel, MODELS } from "./check-compose-invariants.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const guard = join(import.meta.dirname, "check-compose-invariants.mjs");

/**
 * A contract is only worth having if it fails when the thing it describes
 * changes. Most of these tests therefore run the checker against a model that
 * has been deliberately broken and assert that it notices -- a checker that
 * only ever passes is indistinguishable from no checker.
 */

/**
 * Runs `evaluate` against a contract and a model handed in directly.
 *
 * The checker always evaluates both models; a test that supplies only one is
 * making a statement about that one, so failures belonging to the other are
 * dropped. Coverage failures are dropped too unless a test asks for them --
 * most of these tests are about how a single row is evaluated, and every one of
 * them would otherwise have to name every service in its fixture to say so.
 */
function evaluateAgainst(invariants, models, { coverage = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "near-chat-compose-invariants-"));
  try {
    writeFileSync(join(directory, "compose-invariants.json"), JSON.stringify({ invariants }));
    const failures = evaluate(directory, (_root, file) => {
      const key = Object.keys(MODELS).find((name) => MODELS[name] === file);
      return models[key] ?? { services: { unsupplied: {} } };
    });
    const absent = Object.keys(MODELS)
      .filter((key) => !(key in models))
      .map((key) => MODELS[key]);
    return failures
      .filter((failure) => !absent.some((file) => failure.startsWith(file)))
      .filter((failure) => coverage || !/is not named by any row/.test(failure));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A minimal model that satisfies nothing in particular; tests mutate a copy. */
function baseModel() {
  return {
    name: "near-chat",
    services: {
      backend: {
        image: "${BACKEND_IMAGE:?BACKEND_IMAGE is required}",
        ports: [{ mode: "ingress", protocol: "tcp", published: "4005", target: 4000, host_ip: "127.0.0.1" }],
        environment: ["TRUST_PROXY_HOPS=1", "LOG_LEVEL"],
        networks: { default: null },
        command: null,
      },
    },
    volumes: { pgdata: { name: "near-chat_pgdata" } },
  };
}

test("passes when the model matches the contract", () => {
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.ports[0].host_ip", expect: "127.0.0.1", why: "#631" }],
    { prod: baseModel(), release: baseModel() },
  );
  assert.deepEqual(failures, []);
});

test("fails when a published port stops being loopback-only", () => {
  const tampered = baseModel();
  tampered.services.backend.ports[0].host_ip = "0.0.0.0";
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.ports[0].host_ip", expect: "127.0.0.1", why: "#631 ingress" }],
    { prod: tampered, release: baseModel() },
  );
  assert.equal(failures.length, 1);
  // The message has to be actionable on its own: file, path, expect, actual.
  assert.match(failures[0], /docker-compose\.prod\.yml/);
  assert.match(failures[0], /services\.backend\.ports\[0\]\.host_ip/);
  assert.match(failures[0], /expect: "127\.0\.0\.1"/);
  assert.match(failures[0], /actual: "0\.0\.0\.0"/);
  assert.match(failures[0], /why:\s+#631 ingress/);
});

test("reads a port published on every interface as a value, not a missing key", () => {
  // Compose omits host_ip entirely when the file names no address. Without the
  // normalization this row would report `<missing>` and read as a formatting
  // artifact rather than as the security change it is.
  const tampered = baseModel();
  delete tampered.services.backend.ports[0].host_ip;
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.ports[0].host_ip", expect: "127.0.0.1", why: "#631" }],
    { prod: tampered, release: baseModel() },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /actual: "0\.0\.0\.0"/);
});

test("keeps an unset pass-through variable distinct from one set to empty", () => {
  const contract = [{ model: "prod", path: "services.backend.environment.LOG_LEVEL", expect: null, why: "#631" }];
  assert.deepEqual(evaluateAgainst(contract, { prod: baseModel() }), []);

  // `LOG_LEVEL=` is a different instruction to Compose than `LOG_LEVEL`: it
  // sets the variable to the empty string instead of passing the host's value
  // through. Collapsing the two would make the row vacuous.
  const tampered = baseModel();
  tampered.services.backend.environment = ["TRUST_PROXY_HOPS=1", "LOG_LEVEL="];
  const failures = evaluateAgainst(contract, { prod: tampered });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /actual: ""/);
});

test("fails a row whose path no longer resolves, rather than passing it", () => {
  // A row left behind after the property it guarded was renamed must fail
  // loudly. Treating an unresolvable path as satisfied is how a contract
  // quietly stops guarding anything.
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.restart", expect: "always", why: "#631" }],
    { prod: baseModel() },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /actual: <missing>/);
});

test("fails when a model renders no services", () => {
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.image", expect: "x", why: "#631" }],
    { prod: { name: "near-chat", services: {} } },
  );
  assert.ok(
    failures.some((failure) => /rendered no services/.test(failure)),
    failures.join("\n"),
  );
});

test("rejects a row that does not say why it is load-bearing", () => {
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.ports[0].host_ip", expect: "127.0.0.1", why: "it should be this" }],
    { prod: baseModel() },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /must cite the issue/);
});

test("rejects a row naming a model that does not exist", () => {
  const failures = evaluateAgainst(
    [{ model: "staging", path: "services.backend.image", expect: "x", why: "#631" }],
    { prod: baseModel() },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /unknown model "staging"/);
});

test("$absent distinguishes a missing property from a present one", () => {
  assert.deepEqual(
    evaluateAgainst([{ model: "prod", path: "services.backend.build", expect: { $absent: true }, why: "#558" }], {
      prod: baseModel(),
    }),
    [],
  );

  const tampered = baseModel();
  tampered.services.backend.build = { context: "." };
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.build", expect: { $absent: true }, why: "#558" }],
    { prod: tampered },
  );
  assert.equal(failures.length, 1);
});

test("$keys fails on an added or removed service", () => {
  const contract = [{ model: "prod", path: "services", expect: { $keys: ["backend"] }, why: "#631" }];
  assert.deepEqual(evaluateAgainst(contract, { prod: baseModel() }), []);

  const tampered = baseModel();
  tampered.services.extra = {};
  assert.equal(evaluateAgainst(contract, { prod: tampered }).length, 1);
});

test("$matches asserts a shape without pinning an interpolated value", () => {
  const contract = [
    { model: "prod", path: "services.backend.image", expect: { $matches: "^\\$\\{BACKEND_IMAGE:\\?" }, why: "#631" },
  ];
  assert.deepEqual(evaluateAgainst(contract, { prod: baseModel() }), []);

  const tampered = baseModel();
  // `:-` instead of `:?` -- renders fine, but a deployment missing the variable
  // would boot something unintended instead of failing.
  tampered.services.backend.image = "${BACKEND_IMAGE:-near-chat:latest}";
  assert.equal(evaluateAgainst(contract, { prod: tampered }).length, 1);
});

test("fails when a service is governed by no row at all", () => {
  // The direction "every row resolves" cannot catch: a service added to a
  // production model with nothing in the contract about it would otherwise pass
  // a contract it is simply absent from.
  const tampered = baseModel();
  tampered.services.adminer = { image: "adminer:latest", ports: [{ published: "8080", target: 8080 }] };
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.ports[0].host_ip", expect: "127.0.0.1", why: "#631" }],
    { prod: tampered },
    { coverage: true },
  );
  assert.ok(
    failures.some((failure) => /services\.adminer is not named by any row/.test(failure)),
    failures.join("\n"),
  );
});

test("reports a service-set mismatch as a key list, not the whole model", () => {
  // A failure nobody can read is a failure nobody acts on.
  const tampered = baseModel();
  tampered.services.adminer = { image: "adminer:latest" };
  const failures = evaluateAgainst(
    [
      { model: "prod", path: "services", expect: { $keys: ["backend"] }, why: "#631" },
      { model: "prod", path: "services.adminer.image", expect: "adminer:latest", why: "#631" },
    ],
    { prod: tampered },
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /actual: \["adminer","backend"\]/);
});

test("normalizeModel drops the nulls Compose injects into every service", () => {
  const normalized = normalizeModel(baseModel());
  assert.deepEqual(normalized.services.backend.networks, ["default"]);
  assert.ok(!("command" in normalized.services.backend), "a null command is a render artifact, not a set command");
});

/**
 * The checked-in contract against the real rendered models. This is the case
 * the acceptance criteria name: the checker must exit 0 on main, and must stop
 * exiting 0 the moment a model is tampered with.
 */
const docker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
const dockerAvailable = !docker.error && docker.status === 0;

test("the checked-in contract holds against the real models", { skip: dockerAvailable ? false : "docker compose unavailable" }, () => {
  assert.deepEqual(evaluate(repoRoot), []);
});

test("the checked-in contract catches a real model being tampered with", { skip: dockerAvailable ? false : "docker compose unavailable" }, () => {
  const rendered = {};
  for (const [key, file] of Object.entries(MODELS)) {
    const result = spawnSync(
      "docker",
      ["compose", "-p", "near-chat", "--env-file", "/dev/null", "-f", file, "config", "--no-interpolate", "--no-path-resolution", "--format", "json"],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    rendered[key] = JSON.parse(result.stdout);
  }

  const contract = JSON.parse(
    spawnSync("node", ["-e", "process.stdout.write(require('fs').readFileSync('compose-invariants.json','utf8'))"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).stdout,
  ).invariants;

  // Publishing prod's backend on every interface is the single change this
  // contract exists to stop: it puts the API on the network without the tunnel,
  // and TRUST_PROXY_HOPS=1 then lets any caller forge X-Forwarded-For.
  rendered.prod.services.backend.ports[0].host_ip = "0.0.0.0";
  const failures = evaluateAgainst(contract, rendered);
  assert.ok(failures.length > 0, "tampering with a real model must fail the contract");
  assert.ok(
    failures.some((failure) => /services\.backend\.ports\[0\]\.host_ip/.test(failure)),
    failures.join("\n"),
  );
});

test("the CLI exits non-zero when the contract does not hold", () => {
  const directory = mkdtempSync(join(tmpdir(), "near-chat-compose-invariants-cli-"));
  try {
    writeFileSync(join(directory, "compose-invariants.json"), JSON.stringify({ invariants: [] }));
    const result = spawnSync(process.execPath, [guard], { cwd: directory, encoding: "utf8" });
    // The managed local runner disallows child processes (EPERM). Keep the
    // assertion at the CLI seam, with a direct evaluation fallback for that
    // runner; CI executes the actual command.
    if (result.error) {
      assert.ok(evaluate(directory).length > 0);
      return;
    }
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no `invariants` rows/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
