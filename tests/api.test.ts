import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.js";

const dbPath = join(tmpdir(), `tennis-api-${process.pid}-${Date.now()}.sqlite`);
let base = "";
let closeServer: () => void;

before(async () => {
  const srv = await startServer({ port: 0, dbPath });
  base = `http://127.0.0.1:${srv.port}`;
  closeServer = srv.close;
});

after(() => {
  closeServer();
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });
});

async function api(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
}

test("API 全流程：创建/重复请求/查询/撤销/完赛拒绝/导出", async () => {
  const created = await api("/matches", {
    method: "POST",
    body: JSON.stringify({ nameA: "林岚", nameB: "赵野" }),
  });
  assert.equal(created.status, 201);
  const id = created.body.id as string;

  const bad = await api("/matches", {
    method: "POST",
    body: JSON.stringify({ nameA: "x", nameB: "x" }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "BAD_NAMES");

  // 第一分
  const p1 = await api(`/matches/${id}/points`, {
    method: "POST",
    body: JSON.stringify({ winner: "A", requestId: "api-1" }),
  });
  assert.equal(p1.status, 201);
  assert.equal(p1.body.applied, true);

  // 重复请求：同 winner，幂等返回
  const dup = await api(`/matches/${id}/points`, {
    method: "POST",
    body: JSON.stringify({ winner: "A", requestId: "api-1" }),
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicated, true);
  assert.equal(dup.body.seq, 1);

  // 冲突请求：同 requestId 不同 winner
  const conflict = await api(`/matches/${id}/points`, {
    method: "POST",
    body: JSON.stringify({ winner: "B", requestId: "api-1" }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "DUPLICATE_REQUEST");

  // 非法 winner
  const badWinner = await api(`/matches/${id}/points`, {
    method: "POST",
    body: JSON.stringify({ winner: "C" }),
  });
  assert.equal(badWinner.status, 400);

  // 查询
  const score = await api(`/matches/${id}`);
  assert.equal(score.status, 200);
  assert.equal(score.body.state.currentSet.currentGame.points.A, 1);

  // 撤销
  const undo = await api(`/matches/${id}/undo`, { method: "POST" });
  assert.equal(undo.status, 200);
  assert.equal(undo.body.removed.requestId, "api-1");
  assert.equal(undo.body.state.currentSet.currentGame.points.A, 0);

  // 空历史再撤销
  const empty = await api(`/matches/${id}/undo`, { method: "POST" });
  assert.equal(empty.status, 409);
  assert.equal(empty.body.error.code, "EMPTY_HISTORY");

  // 不存在的比赛
  const nf = await api("/matches/nope");
  assert.equal(nf.status, 404);

  // 打完比赛（A 两盘 6-0），再记分应 409
  for (let i = 0; i < 48; i++) {
    const r = await api(`/matches/${id}/points`, {
      method: "POST",
      body: JSON.stringify({ winner: "A", requestId: `f-${i}` }),
    });
    assert.ok(r.status < 300, `第 ${i} 分应成功，实际 ${r.status}`);
  }
  const over = await api(`/matches/${id}/points`, {
    method: "POST",
    body: JSON.stringify({ winner: "A", requestId: "over" }),
  });
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, "MATCH_FINISHED");

  // 撤销决胜分重新开放
  const reopen = await api(`/matches/${id}/undo`, { method: "POST" });
  assert.equal(reopen.status, 200);
  assert.equal(reopen.body.state.winner, null);

  const exported = await api(`/matches/${id}/export`);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.points.length, 47);
  assert.ok(Array.isArray(exported.body.undoLog));
});
