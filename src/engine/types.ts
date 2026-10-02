/**
 * 网球计分引擎的纯类型定义。
 * 引擎本身不依赖数据库，便于测试与事件重放。
 */

/** 选手标识：A 或 B（单打）。 */
export type Player = "A" | "B";

/** 普通局当前局面。 */
export interface RegularGame {
  kind: "regular";
  /** 双方在本局已赢得的原始分（0,1,2,3,...，可超过 3）。 */
  points: Record<Player, number>;
}

/** 抢七局面。 */
export interface TiebreakGame {
  kind: "tiebreak";
  /** 双方在抢七中已赢得的分数。 */
  points: Record<Player, number>;
}

export type Game = RegularGame | TiebreakGame;

/** 单盘局面。 */
export interface SetState {
  /** 双方已赢局数。 */
  games: Record<Player, number>;
  /** 当前进行中的局；该盘结束时为 null。 */
  currentGame: Game | null;
}

/** 整场比赛的完整状态。 */
export interface MatchState {
  /** 选手 A 的（虚构）名字。 */
  nameA: string;
  /** 选手 B 的（虚构）名字。 */
  nameB: string;
  /** 已完成盘的结果，按时间顺序；每项记录该盘双方局数（含抢七小分）。 */
  completedSets: Array<{
    games: Record<Player, number>;
    /** 若是抢七决胜，记录抢七小分；否则为 null。 */
    tiebreak: Record<Player, number> | null;
    winner: Player;
  }>;
  /** 当前盘。 */
  currentSet: SetState;
  /** 整场获胜者；未结束为 null。 */
  winner: Player | null;
}

/** 逐分事件：登记一分。 */
export interface PointEvent {
  seq: number;
  requestId: string;
  winner: Player;
  /** ISO 时间字符串，仅作展示。 */
  at: string;
}

export const other = (p: Player): Player => (p === "A" ? "B" : "A");
