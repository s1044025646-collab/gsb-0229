import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPoint,
  createMatch,
  gameLabel,
  replay,
  type MatchState,
  type PointEvent,
  type Side,
  ScoreError,
} from '../engine.js';

function feed(state: MatchState, winners: Side[]): MatchState {
  let s = state;
  for (const w of winners) s = applyPoint(s, w).state;
  return s;
}

function winGames(state: MatchState, winner: Side, games: number): MatchState {
  return feed(state, Array(games * 4).fill(winner) as Side[]);
}

test('普通局：0/15/30/40 与领先两分赢局', () => {
  let s = createMatch(['A', 'B']);
  s = feed(s, [0]);
  assert.equal(gameLabel(s.game, s.players), '15:0');
  s = feed(s, [0, 0]);
  assert.equal(gameLabel(s.game), '40:0');
  s = feed(s, [0]); // 赢局
  assert.deepEqual(s.sets[0]!.games, [1, 0]);
  assert.deepEqual(s.game, [0, 0]);
});

test('占先制：平分、占先、占先丢失后仍能赢局', () => {
  let s = createMatch(['A', 'B']);
  s = feed(s, [0, 0, 0, 1, 1, 1]); // 40:40
  assert.equal(gameLabel(s.game, s.players), '平分');
  s = feed(s, [0]);
  assert.equal(gameLabel(s.game, s.players), '占先 A');
  s = feed(s, [1]); // 占先丢失，回到平分
  assert.equal(gameLabel(s.game, s.players), '平分');
  assert.deepEqual(s.sets[0]!.games, [0, 0]);
  s = feed(s, [1, 0]); // B 占先又被追回
  assert.equal(gameLabel(s.game, s.players), '平分');
  s = feed(s, [0, 0]); // A 连得两分赢局
  assert.deepEqual(s.sets[0]!.games, [1, 0]);
});

test('一盘：6:5 继续比赛，7:5 赢盘', () => {
  let s = createMatch(['A', 'B']);
  s = winGames(s, 0, 5);
  s = winGames(s, 1, 5); // 5:5
  s = winGames(s, 0, 1); // 6:5
  assert.equal(s.sets[0]!.winner, null);
  assert.equal(s.sets.length, 1);
  s = winGames(s, 0, 1); // 7:5
  assert.equal(s.sets[0]!.winner, 0);
  assert.deepEqual(s.sets[0]!.games, [7, 5]);
});

test('6:0 至 6:4 直接赢盘，6:6 进抢七', () => {
  let s = createMatch(['A', 'B']);
  s = winGames(s, 0, 5);
  s = winGames(s, 1, 4); // 5:4
  s = winGames(s, 0, 1); // 6:4
  assert.equal(s.sets[0]!.winner, 0);

  let t = createMatch(['A', 'B']);
  t = winGames(t, 0, 5);
  t = winGames(t, 1, 5);
  t = winGames(t, 0, 1); // 6:5
  t = winGames(t, 1, 1); // 6:6
  assert.notEqual(t.sets[0]!.tiebreak, null);
  assert.equal(t.sets[0]!.winner, null);
});

test('抢七：7:6 继续，8:6 结束该盘', () => {
  let s = createMatch(['A', 'B']);
  s = winGames(s, 0, 5);
  s = winGames(s, 1, 5);
  s = winGames(s, 0, 1);
  s = winGames(s, 1, 1);
  // 抢七打到 6:6
  s = feed(s, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  assert.deepEqual(s.sets[0]!.tiebreak, [6, 6]);
  s = feed(s, [0]); // 7:6 未结束
  assert.deepEqual(s.sets[0]!.tiebreak, [7, 6]);
  assert.equal(s.sets[0]!.winner, null);
  s = feed(s, [0]); // 8:6 结束
  assert.equal(s.sets[0]!.winner, 0);
  assert.deepEqual(s.sets[0]!.games, [7, 6]);
});

test('抢七后下一盘恢复普通局', () => {
  let s = createMatch(['A', 'B']);
  s = winGames(s, 0, 5);
  s = winGames(s, 1, 5);
  s = winGames(s, 0, 1);
  s = winGames(s, 1, 1);
  // 抢七先到 6:6，再 8:6 赢盘
  s = feed(s, [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0] as Side[]);
  assert.equal(s.sets[0]!.winner, 0);
  assert.equal(s.sets.length, 2);
  assert.equal(s.sets[1]!.tiebreak, null);
  s = feed(s, [0]); // 新盘第一分，普通局 15:0
  assert.equal(gameLabel(s.game), '15:0');
});

test('赢下两盘后比赛结束并拒绝继续记分', () => {
  let s = createMatch(['A', 'B']);
  s = winGames(s, 0, 6); // A 6:0
  s = winGames(s, 1, 6); // B 6:0
  s = winGames(s, 0, 6); // A 6:0 -> 2:1
  assert.equal(s.winner, 0);
  assert.equal(s.sets.length, 3);
  assert.throws(
    () => applyPoint(s, 0),
    (err: unknown) => err instanceof ScoreError && err.code === 'MATCH_FINISHED',
  );
});

test('事件重放与逐次推进结果一致；撤销最后一分可跨赢局/赢盘/终场边界恢复', () => {
  const winners: Side[] = [];
  // 构造一场 A 以 7:6(抢七)、0:6、6:0 获胜的比赛
  // 第 1 盘先打到 6:6：双方各 5 局，再各 1 局
  const mkSetTiebreak: Side[] = [
    ...(Array(20).fill(0) as Side[]),
    ...(Array(20).fill(1) as Side[]),
    ...(Array(4).fill(0) as Side[]),
    ...(Array(4).fill(1) as Side[]),
  ];
  winners.push(...mkSetTiebreak);
  winners.push(...([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0] as Side[])); // 抢七 8:6
  winners.push(...(Array(24).fill(1) as Side[])); // B 6:0
  winners.push(...(Array(23).fill(0) as Side[])); // A 5:0 + 40:0
  winners.push(0); // 冠军点

  const direct = feed(createMatch(['A', 'B']), winners);
  assert.equal(direct.winner, 0);

  const events: PointEvent[] = winners.map((w, i) => ({
    seq: i + 1,
    winner: w,
    requestId: `r${i + 1}`,
    at: new Date(0).toISOString(),
  }));
  const replayed = replay(['A', 'B'], events);
  assert.deepEqual(replayed, direct);

  // 撤销冠军点：比赛重新开放，当前局回到 40:0
  const undone = replay(['A', 'B'], events.slice(0, -1));
  assert.equal(undone.winner, null);
  assert.deepEqual(undone.game, [3, 0]);
  assert.equal(undone.sets.length, 3);

  // 继续撤销直到退掉第 3 盘所有局：跨赢盘边界回到第 2 盘结束、第 3 盘未开始
  const beforeThirdSet = replay(['A', 'B'], events.slice(0, 24 + 24 + 14 + 24));
  assert.equal(beforeThirdSet.sets.length, 3); // 第3盘空盘已在第2盘结束时建立
  assert.deepEqual(beforeThirdSet.sets[2]!.games, [0, 0]);
  assert.equal(beforeThirdSet.winner, null);
});
