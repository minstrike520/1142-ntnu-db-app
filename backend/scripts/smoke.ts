#!/usr/bin/env bun
/**
 * WebSocket/REST smoke test for a running near-chat stack (dev or
 * production-like Docker Compose). Exercises exactly the acceptance criteria
 * of issue #536: connect, reliable send, sync-cursor repair, over-limit
 * handling. Graceful restart is exercised by the caller (see
 * `scripts/smoke.sh`), which runs this script once before and once after
 * restarting the backend container.
 *
 * Every check prints its own actionable diagnostic on failure and the script
 * exits non-zero if any check failed, so it is safe to wire directly into a
 * CI step without extra log-scraping.
 */
import { io as ioClient, type Socket } from 'socket.io-client';

const BASE_URL = (process.env.SMOKE_API_URL ?? 'http://localhost:4005').replace(/\/$/, '');
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(name: string, fn: () => Promise<void>): Promise<void> {
  process.stdout.write(`- ${name} ... `);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('OK');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log('FAIL');
    console.error(`    ${detail.split('\n').join('\n    ')}`);
  }
}

async function api(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON body (e.g. 204); leave as raw text
  }
  return { status: res.status, body };
}

async function register(email: string, name: string, password = 'Password123!') {
  const res = await api('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, name, password }),
  });
  assert(
    res.status === 201,
    `expected 201 registering ${email}, got ${res.status}: ${JSON.stringify(res.body)}`,
  );
  return res.body.token as string;
}

async function createRoom(token: string, name: string): Promise<string> {
  const res = await api('/api/v1/rooms', {
    method: 'POST',
    token,
    body: JSON.stringify({ type: 'group', name }),
  });
  assert(res.status === 201, `expected 201 creating room, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body.roomId as string;
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out waiting for realtime_ready within 10s'));
    }, 10_000);
    socket.once('realtime_ready', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`socket connect_error: ${err.message}`));
    });
  });
}

async function main() {
  console.log(`near-chat realtime smoke test against ${BASE_URL}`);

  await run('health endpoint responds', async () => {
    const res = await api('/api/v1/health');
    assert(res.status === 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body?.status === 'ok', `expected {status:"ok"}, got ${JSON.stringify(res.body)}`);
  });

  let token = '';
  let roomId = '';
  let socket: Socket | undefined;

  await run('socket connects and reaches realtime_ready', async () => {
    token = await register(`smoke-${RUN_ID}@example.com`, 'Smoke User');
    roomId = await createRoom(token, `smoke-room-${RUN_ID}`);
    socket = await connectSocket(token);
  });

  await run('reliable send is idempotent under a retried command', async () => {
    assert(roomId, 'no room available from the previous check');
    const key = `smoke-create-${RUN_ID}`;
    const first = await api(`/api/v1/rooms/${roomId}/messages`, {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ content: 'first attempt' }),
    });
    const retry = await api(`/api/v1/rooms/${roomId}/messages`, {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ content: 'retried attempt' }),
    });
    assert(first.status === 201, `expected 201 on first send, got ${first.status}: ${JSON.stringify(first.body)}`);
    assert(retry.status === 201, `expected 201 on retried send, got ${retry.status}: ${JSON.stringify(retry.body)}`);
    assert(
      retry.body.messageId === first.body.messageId,
      `retry created a second message: first=${first.body.messageId} retry=${retry.body.messageId}`,
    );
    assert(
      retry.body.content === 'first attempt',
      `retry applied the retried body instead of replaying the first one: got "${retry.body.content}"`,
    );
  });

  await run('sync cursor repairs a change missed while disconnected', async () => {
    assert(socket, 'no socket available from the connect check');
    socket.close();
    const key = `smoke-offline-${RUN_ID}`;
    const offline = await api(`/api/v1/rooms/${roomId}/messages`, {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ content: 'sent while disconnected' }),
    });
    assert(
      offline.status === 201,
      `expected 201 sending while disconnected, got ${offline.status}: ${JSON.stringify(offline.body)}`,
    );

    const reconnected = await connectSocket(token);
    reconnected.close();

    const sync = await api('/api/v1/sync?cursor=0&limit=100', { token });
    assert(sync.status === 200, `expected 200 from /sync, got ${sync.status}: ${JSON.stringify(sync.body)}`);
    const changes: Array<{ message?: { messageId?: string } }> = sync.body.changes ?? [];
    assert(
      changes.some((change) => change.message?.messageId === offline.body.messageId),
      `sync cursor did not return the message sent while disconnected (messageId=${offline.body.messageId}); got ${changes.length} change(s)`,
    );
  });

  await run('over-limit auth requests are rejected with 429', async () => {
    const email = `smoke-ratelimit-${RUN_ID}@example.com`;
    await register(email, 'Smoke Ratelimit User');
    let sawTooManyRequests = false;
    const attempts = 15;
    for (let attempt = 1; attempt <= attempts && !sawTooManyRequests; attempt += 1) {
      const res = await api('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
      if (res.status === 429) {
        sawTooManyRequests = true;
        assert(
          res.body?.code === 'TOO_MANY_REQUESTS',
          `expected code TOO_MANY_REQUESTS on 429, got ${JSON.stringify(res.body)}`,
        );
      } else {
        assert(
          res.status === 401,
          `expected 401 for a wrong-password login attempt (or 429 once over the limit), got ${res.status}: ${JSON.stringify(res.body)}`,
        );
      }
    }
    assert(
      sawTooManyRequests,
      `never received a 429 after ${attempts} failed login attempts — is RATE_LIMIT_DISABLED set on this stack?`,
    );
  });

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.error('Failing checks:');
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke test crashed unexpectedly:', err);
  process.exit(1);
});
