/**
 * 纯函数网球计分引擎：由逐分事件推导比分状态。
 * 赛制：三盘两胜；普通局占先制（deuce/advantage，领先两分赢局）；
 * 6:6 进入七分抢七，先到 7 分且领先两分；抢七结束后下一盘恢复普通局。
 */

export type Side = 0 | 1;

export interface SetScore {
  /** 每方赢下的局数 */
  games: [number, number];
  /** 抢七小分；未进入抢七时为 null */
  tiebreak: [number, number] | null;
  /** 该盘胜者（0/1），未完成为 null */
  winner: Side | null;
}

export interface MatchState {
  /** 选手显示名 */
  players: [string, string];
  /** 已完成/进行中的盘，最多 3 盘 */
  sets: SetScore[];
  /** 当前普通局比分（以“得分点数”计，0/1/2/3，3 以上表示平分与占先阶段） */
  game: [number, number];
  /** 整场胜者；null 表示进行中 */
  winner: Side | null;
  /** 已登记的有效得分数 */
  pointCount: number;
}

export interface PointEvent {
  seq: number;
  winner: Side;
  requestId: string;
  at: string;
}

export interface AppliedPoint {
  state: MatchState;
  events: string[];
}

export function createMatch(players: [string, string]): MatchState {
  return {
    players,
    sets: [newSet()],
    game: [0, 0],
    winner: null,
    pointCount: 0,
  };
}

function newSet(): SetScore {
  return { games: [0, 0], tiebreak: null, winner: null };
}

export class ScoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ScoreError';
  }
}

/**
 * 在给定状态上登记一分，返回新状态与发生的状态变化事件（中文描述）。
 * 不修改入参。
 */
export function applyPoint(prev: MatchState, winner: Side): AppliedPoint {
  if (prev.winner !== null) {
    throw new ScoreError('MATCH_FINISHED', '比赛已结束，不能继续记分');
  }
  const state: MatchState = cloneState(prev);
  const events: string[] = [];
  const loser: Side = winner === 0 ? 1 : 0;
  const current = state.sets[state.sets.length - 1]!;

  if (current.tiebreak !== null) {
    current.tiebreak[winner] += 1;
    events.push(`抢七 ${current.tiebreak[0]}:${current.tiebreak[1]}`);
    if (current.tiebreak[winner] >= 7 && current.tiebreak[winner] - current.tiebreak[loser] >= 2) {
      current.games[winner] += 1;
      current.winner = winner;
      events.push(`${state.players[winner]} 以抢七 ${current.tiebreak[winner]}:${current.tiebreak[loser]} 赢下第 ${state.sets.length} 盘`);
      state.game = [0, 0];
      finishSetIfMatchDone(state, winner, events);
    }
  } else {
    state.game[winner] += 1;
    events.push(`本局 ${gameLabel(state.game, state.players)}`);
    const w = state.game[winner];
    const l = state.game[loser];
    if (w >= 4 && w - l >= 2) {
      current.games[winner] += 1;
      state.game = [0, 0];
      events.push(`${state.players[winner]} 保发/破发赢局，盘内局分 ${current.games[0]}:${current.games[1]}`);
      checkSetFinish(current, state, events);
    }
  }

  state.pointCount += 1;
  return { state, events };
}

function checkSetFinish(current: SetScore, state: MatchState, events: string[]): void {
  const [g0, g1] = current.games;
  let winner: Side | null = null;
  // 7:5 赢盘；7:6 只能由抢七分支触发（普通局下 6:6 已进入抢七）
  if (g0 === 7 && g1 === 5) winner = 0;
  if (g1 === 7 && g0 === 5) winner = 1;
  // 6:0 至 6:4 赢盘
  if (g0 === 6 && g1 <= 4) winner = 0;
  if (g1 === 6 && g0 <= 4) winner = 1;
  if (winner !== null) {
    current.winner = winner;
    events.push(`${state.players[winner]} 以 ${g0}:${g1} 赢下第 ${state.sets.length} 盘`);
    finishSetIfMatchDone(state, winner, events);
    return;
  }
  // 未赢盘且局分 6:6，进入抢七
  if (g0 === 6 && g1 === 6) {
    current.tiebreak = [0, 0];
    events.push('局分 6:6，进入七分抢七');
  }
}

function finishSetIfMatchDone(state: MatchState, setWinner: Side, events: string[]): void {
  const wonSets = state.sets.filter((s) => s.winner === setWinner).length;
  if (wonSets === 2) {
    state.winner = setWinner;
    events.push(`${state.players[setWinner]} 赢下整场比赛（三盘两胜）`);
    return;
  }
  if (state.sets.length < 3) {
    state.sets.push(newSet());
    state.game = [0, 0];
    events.push(`进入第 ${state.sets.length} 盘，恢复普通局计分`);
  }
}

/** 由完整有效事件序列重放得到状态（撤销即截断后重放，天然跨边界正确）。 */
export function replay(players: [string, string], events: PointEvent[]): MatchState {
  let state = createMatch(players);
  for (const ev of events) {
    state = applyPoint(state, ev.winner).state;
  }
  return state;
}

/** 0/15/30/40、40:40 平分、占先 的中文展示。 */
export function gameLabel(game: [number, number], players: [string, string] = ['甲', '乙']): string {
  const points = ['0', '15', '30', '40'];
  const [a, b] = game;
  if (a <= 3 && b <= 3) {
    if (a === 3 && b === 3) return '平分';
    return `${points[a]}:${points[b]}`;
  }
  if (a === b) return '平分';
  return a > b ? `占先 ${players[0]}` : `占先 ${players[1]}`;
}

function cloneState(s: MatchState): MatchState {
  return {
    players: [...s.players] as [string, string],
    sets: s.sets.map((set) => ({
      games: [...set.games] as [number, number],
      tiebreak: set.tiebreak ? ([...set.tiebreak] as [number, number]) : null,
      winner: set.winner,
    })),
    game: [...s.game] as [number, number],
    winner: s.winner,
    pointCount: s.pointCount,
  };
}

/** 生成面向用户的完整比分描述。 */
export function describeState(state: MatchState): string {
  const setParts = state.sets.map((s, i) => {
    const tb = s.tiebreak ? `（抢七 ${s.tiebreak[0]}:${s.tiebreak[1]}）` : '';
    const done = s.winner !== null ? ' ✓' : '';
    return `第${i + 1}盘 ${s.games[0]}:${s.games[1]}${tb}${done}`;
  });
  const lines = [...setParts];
  if (state.winner === null) {
    const current = state.sets[state.sets.length - 1]!;
    if (current.tiebreak !== null) {
      lines.push(`当前抢七 ${current.tiebreak[0]}:${current.tiebreak[1]}`);
    } else {
      lines.push(`当前局 ${gameLabel(state.game, state.players)}`);
    }
  } else {
    lines.push(`比赛结束：${state.players[state.winner]} 获胜`);
  }
  return lines.join('\n');
}
