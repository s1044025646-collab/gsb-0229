import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPoint,
  initialState,
  regularPointLabel,
  replay,
} from "../src/engine/engine.js";
import { MatchState, Player } from "../src/engine/types.js";

/** 按序列批量记分。w 中每个字符 A/B 表示该分获胜者。 */
function run(seq: string): MatchState {
  let s = initialState("甲", "乙");
  for (const c of seq) s = applyPoint(s, c as Player);
  return s;
}

/** 让一方连续赢 n 分。 */
function holds(n: number, server: Player): string {
  return server.repeat(n);
}

test("占先制：40-0 后连赢四球中的平分/占先/丢占先/破发", () => {
  // A 先 40-0（3 分），B 连追 3 分 -> 平分；A 占先；B 再一分 -> 平分；B 再连两分 -> B 破发
  let s = run("AAA" + "BBB");
  const g = s.currentSet.currentGame!;
  assert.equal(g.kind, "regular");
  assert.equal(regularPointLabel(g.points).summary, "平分 (Deuce)");

  s = applyPoint(s, "A");
  assert.equal(regularPointLabel(s.currentSet.currentGame!.points as any).summary, "A 占先");

  s = applyPoint(s, "B"); // 占先丢失，回到平分
  assert.equal(regularPointLabel(s.currentSet.currentGame!.points as any).summary, "平分 (Deuce)");

  s = applyPoint(s, "B");
  assert.equal(regularPointLabel(s.currentSet.currentGame!.points as any).summary, "B 占先");
  s = applyPoint(s, "B"); // B 领先两分赢局
  assert.deepEqual(s.currentSet.games, { A: 0, B: 1 });
});

test("普通局领先两球才赢：4-2 球分赢局，4-3 不赢", () => {
  let s = run("AAAABB"); // 4-2
  assert.deepEqual(s.currentSet.games, { A: 1, B: 0 });

  s = initialState("甲", "乙");
  s = run("AAABBBA"); // 4-3，不结束
  assert.equal(s.currentSet.currentGame?.kind, "regular");
});

test("盘分 6-5 继续比赛，7-5 赢盘", () => {
  // A 赢 6 个发球/接发球局，B 赢 5 局 -> 6-5 不结束；A 再赢一局 -> 7-5 结束
  let games = "";
  // 构造局序：A B 交替到 5-5，然后 A A -> 7-5
  for (let i = 0; i < 5; i++) games += holds(4, "A") + holds(4, "B");
  games += holds(4, "A"); // 6-5
  let s = run(games);
  assert.equal(s.completedSets.length, 0, "6-5 不应结束该盘");
  assert.deepEqual(s.currentSet.games, { A: 6, B: 5 });

  s = run(games + holds(4, "A")); // 7-5
  assert.equal(s.completedSets.length, 1);
  assert.deepEqual(s.completedSets[0]!.games, { A: 7, B: 5 });
  assert.equal(s.completedSets[0]!.winner, "A");
  assert.equal(s.completedSets[0]!.tiebreak, null);
});

test("6-4 赢盘（先到 6 领先 2）", () => {
  // 6 局 A，中间插 4 局 B，比分交错到 6-4
  let games = "";
  for (let i = 0; i < 4; i++) games += holds(4, "A") + holds(4, "B");
  games += holds(4, "A").repeat(2);
  const t = run(games);
  assert.deepEqual(t.completedSets[0]!.games, { A: 6, B: 4 });
});

test("抢七：6-6 进入；7-6 继续；8-6 结束该盘（7-6 局分）", () => {
  let games = "";
  for (let i = 0; i < 6; i++) games += holds(4, "A") + holds(4, "B"); // 6-6
  let s = run(games);
  assert.equal(s.currentSet.currentGame?.kind, "tiebreak", "6-6 应进入抢七");

  // 抢七 6-6：A B 各 6 分
  let tb = "";
  for (let i = 0; i < 6; i++) tb += "AB";
  s = run(games + tb);
  assert.equal(s.currentSet.currentGame?.kind, "tiebreak");
  assert.deepEqual(
    (s.currentSet.currentGame as { points: Record<Player, number> }).points,
    { A: 6, B: 6 },
  );

  // 7-6（A 再一分）仍继续
  let s2 = run(games + tb + "A");
  assert.equal(s2.completedSets.length, 0, "抢七 7-6 不应结束");

  // B 扳平 7-7，再 A A -> 9-7？ 按题意构造 8-6：在 6-6 后 A、A 不成立(8-6 需要从6-6连得2分=8-6)
  s2 = run(games + tb + "AA"); // 8-6
  assert.equal(s2.completedSets.length, 1, "抢七 8-6 结束该盘");
  assert.deepEqual(s2.completedSets[0]!.games, { A: 7, B: 6 });
  assert.deepEqual(s2.completedSets[0]!.tiebreak, { A: 8, B: 6 });
  // 下一盘恢复普通局
  assert.equal(s2.currentSet.currentGame?.kind, "regular");
  assert.deepEqual(s2.currentSet.games, { A: 0, B: 0 });
});

test("赢下两盘后整场结束，继续记分被拒绝", () => {
  // 两个 6-0
  const bagel = holds(4, "A").repeat(6);
  const s = run(bagel + bagel);
  assert.equal(s.completedSets.length, 2);
  assert.equal(s.winner, "A");
  assert.throws(() => applyPoint(s, "A"), /MATCH_FINISHED/);
});

test("撤销语义：逐分回退等价于从更短序列重放（跨赢局/赢盘/完赛边界）", () => {
  const bagel = holds(4, "B").repeat(6);
  const seq = bagel + bagel; // B 两盘横扫，最后一分后比赛结束
  assert.equal(run(seq).winner, "B");

  // 去掉最后一分 -> 与 seq[:-1] 重放一致：比赛重新开放
  const reopened = replay("甲", "乙", seq.slice(0, -1).split("") as Player[]);
  assert.equal(reopened.winner, null, "撤销决胜分后比赛应重新开放");
  assert.equal(reopened.completedSets.length, 1, "只赢了一盘");

  // 再多撤销 4 分（跨回赢盘边界前一整局），与重放等价
  const cut = seq.slice(0, -5);
  const state = replay("甲", "乙", cut.split("") as Player[]);
  assert.equal(state.completedSets.length, 1);
  // 第二盘剩 19 分：B 赢 4 局，第 5 局 3-0
  assert.deepEqual(state.currentSet.games, { A: 0, B: 4 });
  assert.deepEqual(state.currentSet.currentGame, {
    kind: "regular",
    points: { A: 0, B: 3 },
  });
});

test("事件重放结果与逐步 apply 完全一致", () => {
  const seq = "AAAABBB".split("") as Player[]; // 打完一局
  let stepwise = initialState("甲", "乙");
  for (const w of seq) stepwise = applyPoint(stepwise, w);
  const replayed = replay("甲", "乙", seq);
  assert.deepEqual(replayed, stepwise);
});
