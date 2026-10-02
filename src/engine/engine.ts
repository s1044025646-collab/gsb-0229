import { MatchState, Player, other } from "./types.js";

/** 初始状态：0-0，第一盘第一个普通局，0:0。 */
export function initialState(nameA: string, nameB: string): MatchState {
  return {
    nameA,
    nameB,
    completedSets: [],
    currentSet: {
      games: { A: 0, B: 0 },
      currentGame: { kind: "regular", points: { A: 0, B: 0 } },
    },
    winner: null,
  };
}

function newRegularGame() {
  return { kind: "regular" as const, points: { A: 0, B: 0 } };
}

/**
 * 判断一个普通局是否结束。
 * 占先制：一方至少 4 分且领先 2 分才赢局（4-2, 5-3, ...）。
 */
export function regularGameWinner(p: { A: number; B: number }): Player | null {
  const lead = p.A - p.B;
  if (p.A >= 4 && lead >= 2) return "A";
  if (p.B >= 4 && -lead >= 2) return "B";
  return null;
}

/** 抢七：至少 7 分且领先 2 分。 */
export function tiebreakWinner(p: { A: number; B: number }): Player | null {
  const lead = p.A - p.B;
  if (p.A >= 7 && lead >= 2) return "A";
  if (p.B >= 7 && -lead >= 2) return "B";
  return null;
}

/**
 * 判断一盘是否结束。
 * - 先到 6 局且领先 2 局：6-0..6-4, 7-5
 * - 6-6 后进入抢七，抢七赢家以 7-6 赢下该盘。
 */
function settleSet(games: { A: number; B: number }): Player | null {
  const { A, B } = games;
  // 7-5（无抢七）或 7-6（抢七决胜）
  if (A === 7 && (B === 5 || B === 6)) return "A";
  if (B === 7 && (A === 5 || A === 6)) return "B";
  if (A === 6 && B <= 4) return "A";
  if (B === 6 && A <= 4) return "B";
  return null;
}

export class ScoreError extends Error {
  constructor(
    public code:
      | "MATCH_FINISHED"
      | "INVALID_PLAYER"
      | "BAD_NAMES",
  ) {
    super(code);
    this.name = "ScoreError";
  }
}

/**
 * 在给定状态上登记一分，返回【新状态】（不可变式更新）。
 * 比赛结束后再记分抛出 MATCH_FINISHED。
 */
export function applyPoint(prev: MatchState, winner: Player): MatchState {
  if (prev.winner !== null) throw new ScoreError("MATCH_FINISHED");
  if (winner !== "A" && winner !== "B") throw new ScoreError("INVALID_PLAYER");

  const state: MatchState = structuredClone(prev);
  const set = state.currentSet;
  const game = set.currentGame;
  if (!game) throw new ScoreError("MATCH_FINISHED");

  game.points[winner] += 1;

  let gameWinner: Player | null;
  if (game.kind === "tiebreak") {
    gameWinner = tiebreakWinner(game.points);
  } else {
    gameWinner = regularGameWinner(game.points);
  }

  if (gameWinner === null) return state;

  // 本局结束
  const tiebreakPoints = game.kind === "tiebreak" ? { ...game.points } : null;
  set.games[gameWinner] += 1;
  set.currentGame = null;

  const setWinner = settleSet(set.games);
  if (setWinner !== null) {
    // 本盘结束
    state.completedSets.push({
      games: { ...set.games },
      tiebreak: tiebreakPoints,
      winner: setWinner,
    });
    const wins = {
      A: state.completedSets.filter((s) => s.winner === "A").length,
      B: state.completedSets.filter((s) => s.winner === "B").length,
    };
    if (wins.A >= 2 || wins.B >= 2) {
      // 整场结束
      state.winner = wins.A >= 2 ? "A" : "B";
      state.currentSet = { games: { ...set.games }, currentGame: null };
      return state;
    }
    // 开始下一盘，恢复普通局
    state.currentSet = { games: { A: 0, B: 0 }, currentGame: newRegularGame() };
    return state;
  }

  // 本盘未结束：判断下一普通局还是抢七
  if (set.games.A === 6 && set.games.B === 6) {
    set.currentGame = { kind: "tiebreak", points: { A: 0, B: 0 } };
  } else {
    set.currentGame = newRegularGame();
  }
  return state;
}

/**
 * 从事件列表完整重放，得到状态。
 * 事件必须按 seq 升序且连续（1..n）。
 */
export function replay(
  nameA: string,
  nameB: string,
  winners: Player[],
): MatchState {
  let state = initialState(nameA, nameB);
  for (const w of winners) state = applyPoint(state, w);
  return state;
}

/** 普通局原始分 -> 展示文字：0/15/30/40、平分、占先。 */
export function regularPointLabel(p: { A: number; B: number }): {
  A: string;
  B: string;
  summary: string;
} {
  const raw = (n: number): string => {
    if (n <= 3) return ["0", "15", "30", "40"][n]!;
    return "40"; // 3 分以上在占先制里展示为 40 或占先
  };
  const atDeuce = p.A >= 3 && p.B >= 3 && p.A === p.B;
  const advA = p.A >= 4 && p.A - p.B === 1;
  const advB = p.B >= 4 && p.B - p.A === 1;
  if (atDeuce) {
    return { A: "40", B: "40", summary: "平分 (Deuce)" };
  }
  if (advA) {
    return { A: "占先", B: "40", summary: "A 占先" };
  }
  if (advB) {
    return { A: "40", B: "占先", summary: "B 占先" };
  }
  return { A: raw(p.A), B: raw(p.B), summary: `${raw(p.A)} - ${raw(p.B)}` };
}

/** 抢七/普通局当前局的紧凑文字（选手名字由调用方替换）。 */
export function gameLabel(
  state: MatchState,
  names: Record<Player, string>,
): string {
  const game = state.currentSet.currentGame;
  if (!game) return "（本盘已结束）";
  if (game.kind === "tiebreak") {
    return `抢七 ${game.points.A}:${game.points.B}（${names.A} : ${names.B}）`;
  }
  const lbl = regularPointLabel(game.points);
  const aText = lbl.A === "占先" ? `占先 ${names.A}` : lbl.A;
  const bText = lbl.B === "占先" ? `占先 ${names.B}` : lbl.B;
  const deuce = lbl.summary.startsWith("平分") ? " — 平分" : "";
  return `局内 ${aText}:${bText}${deuce}`;
}

/** 整场比分的标准展示：盘分 + 当前盘局分 + 当前局。 */
export function formatScore(
  state: MatchState,
  names: Record<Player, string>,
): string {
  const setLines = state.completedSets.map(
    (s, i) =>
      `第${i + 1}盘 ${s.games.A}:${s.games.B}` +
      (s.tiebreak ? `（抢七 ${s.tiebreak.A}:${s.tiebreak.B}）` : "") +
      ` 胜：${names[s.winner]}`,
  );
  const cur = state.currentSet;
  const setNo = state.completedSets.length + 1;
  const head =
    state.winner !== null
      ? `比赛结束，冠军：${names[state.winner]}`
      : `第${setNo}盘 局分 ${cur.games.A}:${cur.games.B}  | ${gameLabel(state, names)}`;
  return [...setLines, head].join("\n");
}

export { other };
