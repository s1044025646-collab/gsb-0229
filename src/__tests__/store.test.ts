import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, StoreError } from '../store.js';
import { replay } from '../engine.js';

let dbPath: string;
let store: Store;

before(() => {
  dbPath = join(tmpdir(), `tennis-test-${process.pid}-${Date.now()}.db`);
  rmSync(dbPath, { force: true });
  store = new Store(dbPath);
});

after(() => {
  store.close();
  rmSync(dbPath, { force: true });
  rmSync(dbPath + '-wal', { force: true });
  rmSync(dbPath + '-shm', { force: true });
});

test('创建与查询比赛', () => {
  store.createMatch('m1', ['甲', '乙']);
  const { state } = store.getMatch('m1');
  assert.equal(state.winner, null);
  assert.deepEqual(state.game, [0, 0]);
  assert.throws(
    () => store.getMatch('nope'),
    (e: unknown) => e instanceof StoreError && e.code === 'MATCH_NOT_FOUND',
  );
});

test('重复请求标识不重复加分；冲突内容报错', () => {
  store.createMatch('m2', ['甲', '乙']);
  const a = store.addPoint('m2', 0, 'req-1');
  assert.equal(a.state.pointCount, 1);
  const dup = store.addPoint('m2', 0, 'req-1');
  assert.equal(dup.replayed, true);
  assert.equal(dup.state.pointCount, 1);
  assert.throws(
    () => store.addPoint('m2', 1, 'req-1'),
    (e: unknown) => e instanceof StoreError && e.code === 'REQUEST_CONFLICT',
  );
  assert.equal(store.getMatch('m2').state.pointCount, 1);
});

test('连续撤销与空历史撤销', () => {
  store.createMatch('m3', ['甲', '乙']);
  assert.throws(
    () => store.undoPoint('m3'),
    (e: unknown) => e instanceof StoreError && e.code === 'EMPTY_HISTORY',
  );
  store.addPoint('m3', 0, 'p1');
  store.addPoint('m3', 0, 'p2');
  store.addPoint('m3', 1, 'p3');
  assert.equal(store.getMatch('m3').state.pointCount, 3);
  assert.equal(store.undoPoint('m3').undone.requestId, 'p3');
  assert.equal(store.undoPoint('m3').undone.requestId, 'p2');
  assert.equal(store.getMatch('m3').state.pointCount, 1);
  const again = store.addPoint('m3', 1, 'p3-new');
  assert.equal(again.state.pointCount, 2);
});

test('撤销跨越赢局边界正确恢复', () => {
  store.createMatch('m4', ['甲', '乙']);
  for (let i = 0; i < 4; i++) store.addPoint('m4', 0, `g${i}`);
  assert.deepEqual(store.getMatch('m4').state.sets[0]!.games, [1, 0]);
  const { state } = store.undoPoint('m4');
  assert.deepEqual(state.sets[0]!.games, [0, 0]);
  assert.deepEqual(state.game, [3, 0]);
});

test('重启（重新打开数据库）后状态与事件重放一致', () => {
  store.createMatch('m5', ['甲', '乙']);
  // 打到盘内 5:5，再到 6:5，保持比赛进行中
  for (let i = 0; i < 5 * 4; i++) store.addPoint('m5', 0, `a${i}`);
  for (let i = 0; i < 5 * 4; i++) store.addPoint('m5', 1, `b${i}`);
  for (let i = 0; i < 4; i++) store.addPoint('m5', 0, `a6-${i}`); // 6:5

  // 模拟重启：重新打开同一数据库文件
  const reopened = new Store(dbPath);
  const persisted = reopened.getMatch('m5').state;
  const { points } = reopened.getHistory('m5');
  const replayed = replay(['甲', '乙'], points);
  assert.deepEqual(replayed, persisted);
  assert.deepEqual(persisted.sets[0]!.games, [6, 5]);

  // 继续记 3 分（乙 0:40），重启后撤销 1 分应回到 0:30，跨重启一致
  for (let i = 0; i < 3; i++) reopened.addPoint('m5', 1, `b6-${i}`); // 0:30
  const undone = reopened.undoPoint('m5');
  assert.deepEqual(undone.state.game, [0, 2]); // 撤销一分 -> 0:15
  const persistedAfterUndo = reopened.getMatch('m5').state;
  assert.deepEqual(persistedAfterUndo.sets[0]!.games, [6, 5]);
  // 再用一个新连接验证撤销结果确实落盘
  const reopened2 = new Store(dbPath);
  assert.deepEqual(reopened2.getMatch('m5').state.sets[0]!.games, [6, 5]);
  reopened2.close();
  reopened.close();
});

test('整场结束后通过 Store 拒绝加分，撤销冠军点后重新开放', () => {
  store.createMatch('m6', ['甲', '乙']);
  const add = (winner: 0 | 1, id: string) => store.addPoint('m6', winner, id);
  for (let i = 0; i < 24; i++) add(0, `x${i}`); // 6:0
  for (let i = 0; i < 24; i++) add(1, `y${i}`); // 0:6
  for (let i = 0; i < 23; i++) add(0, `z${i}`); // 5:0, 40:0
  assert.equal(store.getMatch('m6').state.winner, null);
  add(0, 'champion');
  assert.equal(store.getMatch('m6').state.winner, 0);
  assert.throws(
    () => add(0, 'after'),
    (e: unknown) => e instanceof StoreError && e.code === 'MATCH_FINISHED',
  );
  const { state, undone } = store.undoPoint('m6');
  assert.equal(undone.requestId, 'champion');
  assert.equal(state.winner, null);
  assert.deepEqual(state.game, [3, 0]);
});
