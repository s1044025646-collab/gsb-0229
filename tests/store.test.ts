import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, StoreError } from "../src/db/store.js";
import { ScoreError } from "../src/engine/engine.js";

const dbPath = join(tmpdir(), `tennis-test-${process.pid}-${Date.now()}.sqlite`);
let store: Store;

before(() => {
  store = new Store(dbPath);
});

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });
});

test("重复 requestId 相同内容不重复加分；不同内容报冲突", () => {
  const { id } = store.createMatch("林岚", "赵野");
  const first = store.addPoint(id, "A", "req-1");
  assert.equal(first.duplicated, false);
  assert.equal(first.seq, 1);

  const again = store.addPoint(id, "A", "req-1");
  assert.equal(again.duplicated, true);
  assert.equal(again.seq, 1, "seq 不应增长");

  const pts = store.listPoints(id);
  assert.equal(pts.length, 1, "只应有一条得分事件");

  assert.throws(
    () => store.addPoint(id, "B", "req-1"),
    (e: Error) => e instanceof StoreError && e.code === "DUPLICATE_REQUEST",
  );
});

test("连续撤销、空历史撤销报错，撤销后状态可继续记分", () => {
  const { id } = store.createMatch("甲", "乙");
  store.addPoint(id, "A", "r-a");
  store.addPoint(id, "A", "r-b");
  store.addPoint(id, "B", "r-c");

  const u1 = store.undo(id);
  assert.equal(u1.removed.requestId, "r-c");
  assert.equal(store.listPoints(id).length, 2);
  store.undo(id);
  store.undo(id);
  assert.equal(store.listPoints(id).length, 0);

  assert.throws(
    () => store.undo(id),
    (e: Error) => e instanceof StoreError && e.code === "EMPTY_HISTORY",
  );

  // 撤销到空后仍可重新记分
  const fresh = store.addPoint(id, "B", "r-d");
  assert.equal(fresh.seq, 1);
  const log = store.undoLog(id) as Array<{ removed_request_id: string }>;
  assert.deepEqual(
    log.map((l) => l.removed_request_id),
    ["r-c", "r-b", "r-a"],
  );
});

test("撤销跨越赢局/赢盘/完赛边界后恢复正确", () => {
  const { id } = store.createMatch("甲", "乙");
  // B 两盘 6-0 横扫：共 48 分
  for (let i = 0; i < 48; i++) store.addPoint(id, "B", `sweep-${i}`);
  let { state } = store.getMatch(id);
  assert.equal(state.winner, "B");

  // 撤销决胜分：比赛重新开放，回到第二盘 5-0 后 B 领先的局
  const undone = store.undo(id);
  assert.equal(undone.state.winner, null);
  assert.equal(undone.state.completedSets.length, 1);
  assert.deepEqual(undone.state.currentSet.games, { A: 0, B: 5 });

  // 再撤销 3 分：跨回 4-0 的新一局 0-0
  store.undo(id);
  store.undo(id);
  const back = store.undo(id);
  assert.deepEqual(back.state.currentSet.games, { A: 0, B: 5 });
  assert.deepEqual(back.state.currentSet.currentGame, {
    kind: "regular",
    points: { A: 0, B: 0 },
  });
});

test("完赛后记分被拒绝（MATCH_FINISHED），事件不会落库", () => {
  const { id } = store.createMatch("甲", "乙");
  for (let i = 0; i < 48; i++) store.addPoint(id, "A", `fin-${i}`);
  assert.throws(
    () => store.addPoint(id, "A", "fin-extra"),
    (e: Error) => e instanceof ScoreError && e.code === "MATCH_FINISHED",
  );
  assert.equal(store.listPoints(id).length, 48);
});

test("重启后重放：重新打开同一数据库，状态与事件一致", () => {
  const { id } = store.createMatch("可昕", "远舟");
  const seq = "AAAABBBB"; // A 4-2 赢一局，B 4-0 赢一局
  for (const [i, w] of seq.split("").entries()) {
    store.addPoint(id, w as "A" | "B", `rb-${i}`);
  }

  // 用新连接模拟重启
  const reopened = new Store(dbPath);
  try {
    const { state } = reopened.getMatch(id); // getMatch 内部会重放并与快照核对
    assert.deepEqual(state.currentSet.games, { A: 1, B: 1 });
    const exported = reopened.exportMatch(id);
    assert.equal(exported.points.length, seq.length);
  } finally {
    reopened.close();
  }
});

test("不存在的比赛报 MATCH_NOT_FOUND", () => {
  assert.throws(
    () => store.getMatch("no-such-id"),
    (e: Error) => e instanceof StoreError && e.code === "MATCH_NOT_FOUND",
  );
});
