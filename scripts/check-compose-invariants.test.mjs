import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("$every holds a second published port to the same rule as the first", () => {
  // Indexing ports[0] said nothing about a port added after it, so a service
  // could gain a 0.0.0.0 binding beside its loopback one and still pass --
  // reachable without the tunnel, while TRUST_PROXY_HOPS=1 keeps trusting
  // forwarding headers the direct caller can now forge.
  const contract = [
    { model: "prod", path: "services.backend.ports", expect: { $every: { host_ip: "127.0.0.1" } }, why: "#631" },
  ];
  assert.deepEqual(evaluateAgainst(contract, { prod: baseModel() }), []);

  const tampered = baseModel();
  tampered.services.backend.ports.push({ mode: "ingress", protocol: "tcp", published: "4006", target: 4000, host_ip: "0.0.0.0" });
  assert.equal(evaluateAgainst(contract, { prod: tampered }).length, 1);
});

test("$every pins the whole mapping, so a second loopback port is rejected too", () => {
  // host_ip alone answers "is it reachable off-host". It does not answer "is
  // this the only thing published", and a second port on the same service is a
  // surface change nobody reviewed.
  const contract = [
    {
      model: "prod",
      path: "services.backend.ports",
      expect: { $every: { host_ip: "127.0.0.1", published: "4005", target: 4000 } },
      why: "#631",
    },
  ];
  assert.deepEqual(evaluateAgainst(contract, { prod: baseModel() }), []);

  const extra = baseModel();
  extra.services.backend.ports.push({ mode: "ingress", protocol: "tcp", published: "4006", target: 4000, host_ip: "127.0.0.1" });
  assert.equal(evaluateAgainst(contract, { prod: extra }).length, 1);
});

test("$every rejects an empty list rather than passing it vacuously", () => {
  const tampered = baseModel();
  tampered.services.backend.ports = [];
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.backend.ports", expect: { $every: { host_ip: "127.0.0.1" } }, why: "#631" }],
    { prod: tampered },
  );
  assert.equal(failures.length, 1);
});

test("$contains checks the mount exists, not just the volume declaration", () => {
  // A top-level `pgdata:` declaration says the volume exists, not that anything
  // mounts it. Dropping the mount leaves the declaration in place and the
  // database on the container filesystem.
  const contract = [
    {
      model: "prod",
      path: "services.db.volumes",
      expect: { $contains: { source: "pgdata", target: "/var/lib/postgresql" } },
      why: "#631",
    },
  ];
  const mounted = baseModel();
  mounted.services.db = { volumes: [{ source: "pgdata", target: "/var/lib/postgresql", type: "volume" }] };
  assert.deepEqual(evaluateAgainst(contract, { prod: mounted }), []);

  // Target moved off PGDATA: the declaration and the mount both still exist.
  const moved = baseModel();
  moved.services.db = { volumes: [{ source: "pgdata", target: "/tmp/elsewhere", type: "volume" }] };
  assert.equal(evaluateAgainst(contract, { prod: moved }).length, 1);

  const unmounted = baseModel();
  unmounted.services.db = {};
  assert.equal(evaluateAgainst(contract, { prod: unmounted }).length, 1);
});

test("$contains pins the mount type, so a bind cannot stand in for the volume", () => {
  // Rewritten as long-syntax `type: bind` with the same source and target, the
  // named volume goes unused and the bind path resolves relative to wherever
  // the compose file sits -- so deploying from another directory starts an
  // empty database, with source and target both still "correct".
  const contract = [
    {
      model: "prod",
      path: "services.db.volumes",
      expect: { $contains: { type: "volume", source: "pgdata", target: "/var/lib/postgresql" } },
      why: "#631",
    },
  ];
  const bound = baseModel();
  bound.services.db = { volumes: [{ type: "bind", source: "pgdata", target: "/var/lib/postgresql" }] };
  const failures = evaluateAgainst(contract, { prod: bound });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /"type":"bind"/);
});

test("a read-only stateful mount reads as a value, not a missing key", () => {
  // Compose emits `read_only` only when asked, so `:ro` keeps type, source and
  // target identical and a subset match would list only those. Postgres has to
  // write to its data directory, so this takes the stack down at boot.
  const contract = [
    {
      model: "prod",
      path: "services.db.volumes",
      expect: { $contains: { type: "volume", read_only: false, source: "pgdata", target: "/var/lib/postgresql" } },
      why: "#631",
    },
  ];
  const writable = baseModel();
  writable.services.db = { volumes: [{ type: "volume", source: "pgdata", target: "/var/lib/postgresql" }] };
  assert.deepEqual(evaluateAgainst(contract, { prod: writable }), []);

  const readOnly = baseModel();
  readOnly.services.db = {
    volumes: [{ type: "volume", read_only: true, source: "pgdata", target: "/var/lib/postgresql" }],
  };
  const failures = evaluateAgainst(contract, { prod: readOnly });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /"read_only":true/);
});

test("$every pins the protocol, so a udp mapping cannot pass as the tcp one", () => {
  // `3005:3000/udp` leaves host_ip, published and target all untouched, but the
  // HTTP listener is TCP -- nothing answers on the published port.
  const contract = [
    {
      model: "prod",
      path: "services.backend.ports",
      expect: { $every: { host_ip: "127.0.0.1", protocol: "tcp", published: "4005", target: 4000 } },
      why: "#631",
    },
  ];
  const tcp = baseModel();
  assert.deepEqual(evaluateAgainst(contract, { prod: tcp }), []);

  const udp = baseModel();
  udp.services.backend.ports = [{ mode: "ingress", protocol: "udp", published: "4005", target: 4000, host_ip: "127.0.0.1" }];
  assert.equal(evaluateAgainst(contract, { prod: udp }).length, 1);
});

test("an internal network reads as a value, not a missing key", () => {
  // The third key Compose emits only when asked, after host_ip and read_only.
  // An internal network is externally isolated, so cloudflared cannot dial out
  // to Cloudflare -- while the network still exists, is still named `default`,
  // and every service is still attached to it.
  const contract = [{ model: "prod", path: "networks.default.internal", expect: false, why: "#631" }];
  const reachable = baseModel();
  reachable.networks = { default: { name: "near-chat_default" } };
  assert.deepEqual(evaluateAgainst(contract, { prod: reachable }), []);

  const isolated = baseModel();
  isolated.networks = { default: { name: "near-chat_default", internal: true } };
  const failures = evaluateAgainst(contract, { prod: isolated });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /actual: true/);
});

test("asserting one service's binding says nothing about its sibling's", () => {
  // migrate needs its own DATABASE_URL. Deleted, `migrate:up` has no target and
  // fails; the backend then waits forever on service_completed_successfully, so
  // the bundle never comes up. A whole-file `includes` check is satisfied by the
  // backend's correct binding, which is exactly why this is a per-key row.
  const contract = [
    {
      model: "release",
      path: "services.migrate.environment.DATABASE_URL",
      expect: "${DATABASE_URL:?DATABASE_URL is required}",
      why: "#631",
    },
  ];
  const bound = baseModel();
  bound.services.migrate = { environment: { DATABASE_URL: "${DATABASE_URL:?DATABASE_URL is required}" } };
  assert.deepEqual(evaluateAgainst(contract, { release: bound }), []);

  const dropped = baseModel();
  dropped.services.migrate = { environment: { NODE_ENV: "production" } };
  const failures = evaluateAgainst(contract, { release: dropped });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /actual: <missing>/);

  // Rebound to a different required variable: still present, still fail-fast.
  const rebound = baseModel();
  rebound.services.migrate = { environment: { DATABASE_URL: "${JWT_SECRET:?JWT_SECRET is required}" } };
  assert.equal(evaluateAgainst(contract, { release: rebound }).length, 1);
});

test("a service behind a profile is rejected, though `config` still renders it", () => {
  // The fourth key that means something by being absent. `config --format json`
  // renders a profiled service identically, so the service-set, network and
  // restart rows all still pass -- but `up` without a matching --profile skips
  // it. On prod's tunnel that means starting everything except the only ingress.
  const contract = [{ model: "prod", path: "services.*.profiles", expect: { $every: [] }, why: "#631" }];
  const enabled = baseModel();
  enabled.services.tunnel = { image: "cloudflare/cloudflared:latest" };
  assert.deepEqual(evaluateAgainst(contract, { prod: enabled }), []);

  const profiled = baseModel();
  profiled.services.tunnel = { image: "cloudflare/cloudflared:latest", profiles: ["manual"] };
  const failures = evaluateAgainst(contract, { prod: profiled });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /"manual"/);
});

test("a whole-object row catches any key added to it, not just known ones", () => {
  // Networks and volumes are small, fully-known objects, and several of their
  // keys break production by their mere presence: `external` stops `up`
  // creating the resource, `internal` cuts off the only ingress. Enumerating
  // them one at a time means a new round for every key nobody thought of, so
  // the object is pinned entire.
  const contract = [
    { model: "prod", path: "networks.default", expect: { name: "near-chat_default", internal: false }, why: "#631" },
  ];
  const clean = baseModel();
  clean.networks = { default: { name: "near-chat_default" } };
  assert.deepEqual(evaluateAgainst(contract, { prod: clean }), []);

  for (const extra of [{ external: true }, { attachable: true }, { enable_ipv6: true }, { driver: "macvlan" }]) {
    const tampered = baseModel();
    tampered.networks = { default: { name: "near-chat_default", ...extra } };
    assert.equal(
      evaluateAgainst(contract, { prod: tampered }).length,
      1,
      `expected ${JSON.stringify(extra)} to fail the whole-object row`,
    );
  }
});

test("the environment key set is structural; values are pinned only where load-bearing", () => {
  // Most of these are ${VAR:-default} pass-throughs whose defaults legitimately
  // change, so pinning every value would fail on ordinary product changes. But a
  // key appearing, disappearing or being renamed is never routine -- and a
  // deleted key is invisible to every value row, because no value is left to
  // check. Deleting prod's TUNNEL_TOKEN leaves the only ingress with no token.
  const contract = [
    { model: "prod", path: "services.tunnel.environment", expect: { $keys: ["TUNNEL_TOKEN"] }, why: "#631" },
  ];
  const present = baseModel();
  present.services.tunnel = { environment: ["TUNNEL_TOKEN=${TUNNEL_TOKEN}"] };
  assert.deepEqual(evaluateAgainst(contract, { prod: present }), []);

  const dropped = baseModel();
  dropped.services.tunnel = {};
  assert.equal(evaluateAgainst(contract, { prod: dropped }).length, 1);

  // Renamed: still one key, still bound to the same variable, still wrong.
  const renamed = baseModel();
  renamed.services.tunnel = { environment: ["CF_TOKEN=${TUNNEL_TOKEN}"] };
  assert.equal(evaluateAgainst(contract, { prod: renamed }).length, 1);

  // An added key is drift too -- this is what catches a stray debug switch.
  const added = baseModel();
  added.services.tunnel = { environment: ["TUNNEL_TOKEN=${TUNNEL_TOKEN}", "DEBUG_BACKDOOR=1"] };
  assert.equal(evaluateAgainst(contract, { prod: added }).length, 1);
});

test("a whole sub-object row catches a dependency deleted, not just weakened", () => {
  // Naming a condition (`depends_on.db.condition`) cannot see the dependency
  // being removed outright -- there is no condition left to check. prod's
  // backend runs migrate:up on start and prod sets no restart policy, so
  // booting before the database is healthy leaves it down for good.
  const contract = [
    {
      model: "prod",
      path: "services.backend.depends_on",
      expect: { db: { condition: "service_healthy", required: true } },
      why: "#631",
    },
  ];
  const gated = baseModel();
  gated.services.backend.depends_on = { db: { condition: "service_healthy", required: true } };
  assert.deepEqual(evaluateAgainst(contract, { prod: gated }), []);

  const weakened = baseModel();
  weakened.services.backend.depends_on = { db: { condition: "service_started", required: true } };
  assert.equal(evaluateAgainst(contract, { prod: weakened }).length, 1);

  const deleted = baseModel();
  delete deleted.services.backend.depends_on;
  assert.equal(evaluateAgainst(contract, { prod: deleted }).length, 1);
});

test("the service key set closes the whole absent-by-default family at once", () => {
  // Compose has a family of service keys that are absent by default and change
  // how, or whether, the service runs. `scale: 0` renders the service exactly
  // as before and starts zero containers of it; `privileged`, `cap_add`,
  // `user`, `pid` and `devices` change what it can do to the host. Pinning them
  // one at a time meant a fresh round per key, so the key set is asserted.
  const keys = ["command", "depends_on", "environment", "image", "networks", "profiles", "restart"];
  const contract = [{ model: "prod", path: "services.tunnel", expect: { $keys: keys }, why: "#631" }];

  const base = () => {
    const model = baseModel();
    model.services.tunnel = {
      command: "tunnel --no-autoupdate run",
      depends_on: {},
      environment: ["TUNNEL_TOKEN=${TUNNEL_TOKEN}"],
      image: "cloudflare/cloudflared:latest",
      networks: { default: null },
      restart: "always",
    };
    return model;
  };
  assert.deepEqual(evaluateAgainst(contract, { prod: base() }), []);

  for (const [key, value] of [
    ["scale", 0],
    ["deploy", { replicas: 0 }],
    ["privileged", true],
    ["cap_add", ["SYS_ADMIN"]],
    ["user", "root"],
    ["pid", "host"],
    ["devices", ["/dev/kmsg:/dev/kmsg"]],
  ]) {
    const tampered = base();
    tampered.services.tunnel[key] = value;
    assert.equal(
      evaluateAgainst(contract, { prod: tampered }).length,
      1,
      `expected a service gaining ${key} to fail the key-set row`,
    );
  }
});

test("compares objects independently of Compose's key order", () => {
  // Compose does not promise a stable key order and already varies it between
  // render modes; a row must not pass or fail on that.
  const contract = [
    {
      model: "prod",
      path: "services.db.volumes",
      expect: { $contains: { target: "/var/lib/postgresql", source: "pgdata" } },
      why: "#631",
    },
  ];
  const reordered = baseModel();
  reordered.services.db = { volumes: [{ type: "volume", target: "/var/lib/postgresql", source: "pgdata" }] };
  assert.deepEqual(evaluateAgainst(contract, { prod: reordered }), []);
});

test("a `*` path fans out over every service", () => {
  const contract = [{ model: "prod", path: "services.*.networks", expect: { $every: ["default"] }, why: "#631" }];
  const connected = baseModel();
  connected.services.tunnel = { networks: { default: null } };
  assert.deepEqual(evaluateAgainst(contract, { prod: connected }), []);

  // On its own network, cloudflared cannot reach the services it fronts, and
  // every port/restart/image row stays green.
  const split = baseModel();
  split.services.tunnel = { networks: { isolated: null } };
  const failures = evaluateAgainst(contract, { prod: split });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /isolated/);
});

test("a `*` path reports a branch with no value rather than skipping it", () => {
  // `network_mode: none` leaves the service with no `networks` key at all.
  // Dropping unresolved branches would make that the one case the row misses.
  const contract = [{ model: "prod", path: "services.*.networks", expect: { $every: ["default"] }, why: "#631" }];
  const detached = baseModel();
  detached.services.tunnel = { network_mode: "none" };
  const failures = evaluateAgainst(contract, { prod: detached });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /<missing>/);
});

test("a `*` row does not excuse a service from the coverage rule", () => {
  // Otherwise a blanket topology row would mean any new service counts as
  // governed, which is the case the coverage rule exists to catch.
  const tampered = baseModel();
  tampered.services.adminer = { networks: { default: null } };
  const failures = evaluateAgainst(
    [{ model: "prod", path: "services.*.networks", expect: { $every: ["default"] }, why: "#631" }],
    { prod: tampered },
    { coverage: true },
  );
  assert.ok(
    failures.some((failure) => /services\.adminer is not named by any row/.test(failure)),
    failures.join("\n"),
  );
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
const needsDocker = { skip: !docker.error && docker.status === 0 ? false : "docker compose unavailable" };

/** The two production models as Compose actually renders them, right now. */
function renderRealModels() {
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
  return rendered;
}

/** The rows as checked in, so these tests exercise the real contract. */
function checkedInContract() {
  return JSON.parse(readFileSync(join(repoRoot, "compose-invariants.json"), "utf8")).invariants;
}

test("the checked-in contract holds against the real models", needsDocker, () => {
  assert.deepEqual(evaluate(repoRoot), []);
});

test("the checked-in contract catches a real model being tampered with", needsDocker, () => {
  const rendered = renderRealModels();
  // Publishing prod's backend on every interface is the single change this
  // contract exists to stop: it puts the API on the network without the tunnel,
  // and TRUST_PROXY_HOPS=1 then lets any caller forge X-Forwarded-For.
  rendered.prod.services.backend.ports[0].host_ip = "0.0.0.0";
  const failures = evaluateAgainst(checkedInContract(), rendered);
  assert.ok(failures.length > 0, "tampering with a real model must fail the contract");
  assert.ok(
    failures.some((failure) => /docker-compose\.prod\.yml services\.backend\.ports/.test(failure)),
    failures.join("\n"),
  );
});

test("the checked-in contract catches a second, non-loopback port on prod", needsDocker, () => {
  // The regression the review on PR #638 named: a port added beside the
  // loopback one is the realistic way prod ends up reachable without the
  // tunnel, and an index-0 row could not see it.
  const rendered = renderRealModels();
  rendered.prod.services.backend.ports.push({
    mode: "ingress",
    protocol: "tcp",
    published: "4006",
    target: 4000,
  });
  const failures = evaluateAgainst(checkedInContract(), rendered);
  assert.ok(
    failures.some((failure) => /docker-compose\.prod\.yml services\.backend\.ports/.test(failure)),
    failures.join("\n"),
  );
});

test("the checked-in contract catches a service cut off from the compose network", needsDocker, () => {
  // Detaching the tunnel takes production entirely offline while every port,
  // restart, image and volume row stays green -- the P2 raised on PR #638.
  const rendered = renderRealModels();
  delete rendered.prod.services.tunnel.networks;
  rendered.prod.services.tunnel.network_mode = "none";
  const failures = evaluateAgainst(checkedInContract(), rendered);
  assert.ok(
    failures.some((failure) => /docker-compose\.prod\.yml services\.\*\.networks/.test(failure)),
    failures.join("\n"),
  );
});

test("the checked-in contract catches a stateful volume that is declared but not mounted", needsDocker, () => {
  // The other regression named in that review: deleting the mount while
  // leaving the top-level declaration in place starts the database on the
  // container filesystem.
  const rendered = renderRealModels();
  delete rendered.prod.services.db.volumes;
  const failures = evaluateAgainst(checkedInContract(), rendered);
  assert.ok(
    failures.some((failure) => /docker-compose\.prod\.yml services\.db\.volumes/.test(failure)),
    failures.join("\n"),
  );
});

test("the checked-in contract catches a published port aimed at the wrong container port", needsDocker, () => {
  // `3005:3001` still binds the same host address, so a host_ip-only rule
  // passes it -- but the image runs with PORT=3000 (frontend/Dockerfile.prod),
  // so nothing answers on the published port. The release-compose job starts
  // only db, migrate and backend, so it cannot catch this either.
  const rendered = renderRealModels();
  rendered.release.services.frontend.ports[0].target = 3001;
  const failures = evaluateAgainst(checkedInContract(), rendered);
  assert.ok(
    failures.some((failure) => /docker-compose\.release\.yml services\.frontend\.ports/.test(failure)),
    failures.join("\n"),
  );
});

test("the checked-in contract catches a required service scaled to zero", needsDocker, () => {
  // The rendered model still contains the service; only the container count
  // changes. On prod's tunnel that is production with no ingress at all.
  for (const key of ["scale", "deploy"]) {
    const rendered = renderRealModels();
    rendered.prod.services.tunnel[key] = key === "scale" ? 0 : { replicas: 0 };
    assert.ok(
      evaluateAgainst(checkedInContract(), rendered).some((f) =>
        /docker-compose\.prod\.yml services\.tunnel\b/.test(f),
      ),
      `tunnel ${key}`,
    );
  }
});

test("the checked-in contract catches a rebound secret or a swapped image", needsDocker, () => {
  // A key-set row cannot see a rebind: TUNNEL_TOKEN bound to ${JWT_SECRET} is
  // still exactly one key still named TUNNEL_TOKEN. And no row named the
  // third-party images at all, so the only ingress could become busybox with
  // ports, restart, command, environment, depends_on and network all intact.
  const rebound = renderRealModels();
  // prod renders environment in list form, so the rebind has to be written as
  // the list entry it really is -- assigning an object property to an array
  // would be silently dropped by the normalizer and prove nothing.
  rebound.prod.services.tunnel.environment = ["TUNNEL_TOKEN=${JWT_SECRET}"];
  assert.ok(
    evaluateAgainst(checkedInContract(), rebound).some((f) =>
      /services\.tunnel\.environment\.TUNNEL_TOKEN/.test(f),
    ),
    "rebound tunnel token",
  );

  const swapped = renderRealModels();
  swapped.prod.services.tunnel.image = "busybox";
  assert.ok(
    evaluateAgainst(checkedInContract(), swapped).some((f) => /services\.tunnel\.image/.test(f)),
    "swapped tunnel image",
  );
});

test("the checked-in contract catches prod frontend built from the dev Dockerfile", needsDocker, () => {
  // ./frontend/Dockerfile builds fine, but its CMD is `pnpm dev`, so production
  // would serve from the Next.js development server. ci-frontend.yml builds
  // Dockerfile.prod directly and never reads this wiring.
  const rendered = renderRealModels();
  rendered.prod.services.frontend.build.dockerfile = "./frontend/Dockerfile";
  assert.ok(
    evaluateAgainst(checkedInContract(), rendered).some((f) =>
      /docker-compose\.prod\.yml services\.frontend\.build/.test(f),
    ),
    "prod frontend dev Dockerfile",
  );
});

test("the checked-in contract catches environment key drift on either model", needsDocker, () => {
  // The reported case, plus one nobody reported: an added key.
  const dropped = renderRealModels();
  delete dropped.prod.services.tunnel.environment;
  assert.ok(
    evaluateAgainst(checkedInContract(), dropped).some((f) =>
      /docker-compose\.prod\.yml services\.tunnel\.environment/.test(f),
    ),
    "prod tunnel TUNNEL_TOKEN dropped",
  );

  const added = renderRealModels();
  added.release.services.backend.environment.DEBUG_BACKDOOR = "1";
  assert.ok(
    evaluateAgainst(checkedInContract(), added).some((f) =>
      /docker-compose\.release\.yml services\.backend\.environment/.test(f),
    ),
    "release backend gained a key",
  );
});

test("the checked-in contract catches an external network or volume", needsDocker, () => {
  // `external: true` means `up` does not create the resource: a clean host
  // fails outright, and a host where another stack owns that name silently
  // adopts it instead.
  for (const model of ["prod", "release"]) {
    const net = renderRealModels();
    net[model].networks.default.external = true;
    assert.ok(
      evaluateAgainst(checkedInContract(), net).some((f) => new RegExp(`${MODELS[model]} networks\\.default`).test(f)),
      `${model} network`,
    );

    const vol = renderRealModels();
    vol[model].volumes.pgdata.external = true;
    assert.ok(
      evaluateAgainst(checkedInContract(), vol).some((f) => new RegExp(`${MODELS[model]} volumes\\.pgdata`).test(f)),
      `${model} volume`,
    );
  }
});

test("the checked-in contract catches a service put behind a profile", needsDocker, () => {
  for (const [model, service] of [["prod", "tunnel"], ["release", "migrate"]]) {
    const rendered = renderRealModels();
    rendered[model].services[service].profiles = ["manual"];
    const failures = evaluateAgainst(checkedInContract(), rendered);
    assert.ok(
      failures.some((failure) => new RegExp(`${MODELS[model]} services\\.\\*\\.profiles`).test(failure)),
      `${model}: ${failures.join("\n")}`,
    );
  }
});

test("the checked-in contract catches migrate losing its own DATABASE_URL", needsDocker, () => {
  const rendered = renderRealModels();
  delete rendered.release.services.migrate.environment.DATABASE_URL;
  const failures = evaluateAgainst(checkedInContract(), rendered);
  assert.ok(
    failures.some((failure) => /services\.migrate\.environment\.DATABASE_URL/.test(failure)),
    failures.join("\n"),
  );
});

test("the checked-in contract catches a read-only stateful mount", needsDocker, () => {
  // Postgres must write to its data directory; the uploads mount is the same
  // story for every attachment. Neither compose file is booted by CI for prod,
  // so this is the only place it is caught.
  for (const [model, service] of [["prod", "db"], ["release", "backend"]]) {
    const rendered = renderRealModels();
    rendered[model].services[service].volumes[0].read_only = true;
    const failures = evaluateAgainst(checkedInContract(), rendered);
    assert.ok(
      failures.some((failure) => new RegExp(`${MODELS[model]} services\\.${service}\\.volumes`).test(failure)),
      `${model}: ${failures.join("\n")}`,
    );
  }
});

test("the checked-in contract catches a published port switched to udp", needsDocker, () => {
  const rendered = renderRealModels();
  rendered.release.services.frontend.ports[0].protocol = "udp";
  const failures = evaluateAgainst(checkedInContract(), rendered);
  assert.ok(
    failures.some((failure) => /docker-compose\.release\.yml services\.frontend\.ports/.test(failure)),
    failures.join("\n"),
  );
});

test("the checked-in contract catches a renamed engine volume", needsDocker, () => {
  // `pgdata: { name: ... }` keeps the logical key, the mount source, its target
  // and its type all identical, so every other volume row still passes -- while
  // Compose mounts a brand-new volume and the existing database appears gone.
  for (const model of ["prod", "release"]) {
    const rendered = renderRealModels();
    rendered[model].volumes.pgdata.name = "near-chat-v2-pgdata";
    const failures = evaluateAgainst(checkedInContract(), rendered);
    assert.ok(
      failures.some((failure) => new RegExp(`${MODELS[model]} volumes\\.pgdata`).test(failure)),
      `${model}: ${failures.join("\n")}`,
    );
  }
});

test("the checked-in contract catches the database volume rewritten as a bind", needsDocker, () => {
  for (const model of ["prod", "release"]) {
    const rendered = renderRealModels();
    rendered[model].services.db.volumes = [
      { type: "bind", source: "pgdata", target: "/var/lib/postgresql" },
    ];
    const failures = evaluateAgainst(checkedInContract(), rendered);
    assert.ok(
      failures.some((failure) => new RegExp(`${MODELS[model]} services\\.db\\.volumes`).test(failure)),
      `${model}: ${failures.join("\n")}`,
    );
  }
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
