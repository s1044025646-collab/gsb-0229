import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { startServer } from '../server.js';
import type { Store } from '../store.js';

const dbPath = join(tmpdir(), `tennis-api-test-${process.pid}-${Date.now()}.db`);
let server: Server;
let store: Store;
let base: string;

const started = await startServer(undefined, dbPath);
server = started.server;
store = started.store;
base = `http://127.0.0.1:${started.port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
});

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    method: init?.method ?? 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body,
  });
  return { status: res.status, body: await res.json() };
}

test('完整 API 流程：创建、记分、幂等、冲突、撤销、历史', async () => {
  const created = await call('/matches', {
    method: 'POST',
    body: JSON.stringify({ player0: '赵一', player1: '钱二', id: 'api-1' }),
  });
  assert.equal(created.status, 201);

  const bad = await call('/matches', { method: 'POST', body: JSON.stringify({ player0: '', player1: 'B' }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');

  const p1 = await call('/matches/api-1/points', {
    method: 'POST',
    body: JSON.stringify({ winner: 0, requestId: 'r1' }),
  });
  assert.equal(p1.status, 201);
  assert.match(p1.body.text, /15:0/);

  const dup = await call('/matches/api-1/points', {
    method: 'POST',
    body: JSON.stringify({ winner: 0, requestId: 'r1' }),
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.idempotentReplay, true);

  const conflict = await call('/matches/api-1/points', {
    method: 'POST',
    body: JSON.stringify({ winner: 1, requestId: 'r1' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'REQUEST_CONFLICT');

  const undo = await call('/matches/api-1/undo', { method: 'POST' });
  assert.equal(undo.status, 200);
  assert.match(undo.body.text, /0:0/);

  const history = await call('/matches/api-1/history');
  assert.equal(history.body.history.points.length, 0);
  assert.ok(history.body.history.audit.some((a: { kind: string }) => a.kind === 'UNDO'));

  const notFound = await call('/matches/no-such/state');
  assert.equal(notFound.status, 404);
});

test('未知路由返回 404', async () => {
  const res = await call('/nope');
  assert.equal(res.status, 404);
});
