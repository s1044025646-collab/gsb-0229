/**
 * SQLite 持久化层。
 * 设计要点：
 * - 每次记分在一个事务中同时写入 point 事件和当前快照状态；
 * - 快照是缓存，权威来源是事件，重启/打开时用事件重放重建并与快照核对；
 * - request_id 全局唯一，重复提交不重复加分（幂等）；
 * - 撤销 = 删除最后一个有效事件，然后重放重建状态（天然跨越赢局/赢盘/完赛边界）。
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MatchState, Player, PointEvent } from "../engine/types.js";
import { applyPoint, initialState } from "../engine/engine.js";

export class StoreError extends Error {
  constructor(
    public code:
      | "MATCH_NOT_FOUND"
      | "DUPLICATE_REQUEST"
      | "EMPTY_HISTORY"
      | "BAD_STATE",
  ) {
    super(code);
    this.name = "StoreError";
  }
}

interface MatchRow {
  id: string;
  name_a: string;
  name_b: string;
  state: string;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const abs = resolve(dbPath);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new DatabaseSync(abs);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        name_a TEXT NOT NULL,
        name_b TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        winner TEXT NOT NULL CHECK(winner IN ('A','B')),
        at TEXT NOT NULL,
        UNIQUE(match_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_points_match ON points(match_id, seq);
      CREATE TABLE IF NOT EXISTS undo_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        removed_seq INTEGER NOT NULL,
        removed_request_id TEXT NOT NULL,
        removed_winner TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `);
  }

  createMatch(nameA: string, nameB: string): { id: string; state: MatchState } {
    const id = randomUUID();
    const at = new Date().toISOString();
    const state = initialState(nameA, nameB);
    this.db
      .prepare(
        `INSERT INTO matches(id, name_a, name_b, state, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, nameA, nameB, JSON.stringify(state), at);
    return { id, state };
  }

  private getMatchRow(id: string): MatchRow {
    const row = this.db
      .prepare(`SELECT * FROM matches WHERE id = ?`)
      .get(id) as MatchRow | undefined;
    if (!row) throw new StoreError("MATCH_NOT_FOUND");
    return row;
  }

  getMatch(id: string): {
    match: Omit<MatchRow, "state">;
    state: MatchState;
  } {
    const row = this.getMatchRow(id);
    const state = JSON.parse(row.state) as MatchState;
    const { state: rebuilt } = this.replay(id, row.name_a, row.name_b);
    if (JSON.stringify(rebuilt) !== JSON.stringify(state)) {
      throw new StoreError("BAD_STATE");
    }
    const { state: _omit, ...match } = row;
    return { match, state };
  }

  /** 从事件重放重建状态。 */
  replay(
    id: string,
    nameA: string,
    nameB: string,
  ): { state: MatchState; winners: Player[] } {
    const rows = this.db
      .prepare(
        `SELECT winner FROM points WHERE match_id = ? ORDER BY seq ASC`,
      )
      .all(id) as Array<{ winner: Player }>;
    let state = initialState(nameA, nameB);
    const winners: Player[] = [];
    for (const r of rows) {
      state = applyPoint(state, r.winner);
      winners.push(r.winner);
    }
    return { state, winners };
  }

  /**
   * 登记一分（幂等）。
   * 返回 { duplicated: true } 表示该 requestId 已存在；
   * 若同 requestId 携带不同 winner，抛 DUPLICATE_REQUEST（冲突）。
   */
  addPoint(
    matchId: string,
    winner: Player,
    requestId: string,
  ): { state: MatchState; duplicated: boolean; seq: number } {
    const row = this.getMatchRow(matchId);

    const existing = this.db
      .prepare(
        `SELECT seq, winner FROM points WHERE request_id = ? AND match_id = ?`,
      )
      .get(requestId, matchId) as
      | { seq: number; winner: Player }
      | undefined;
    if (existing) {
      if (existing.winner !== winner) throw new StoreError("DUPLICATE_REQUEST");
      return {
        state: JSON.parse(row.state) as MatchState,
        duplicated: true,
        seq: existing.seq,
      };
    }

    const at = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prev = JSON.parse(
        (this.db.prepare(`SELECT state FROM matches WHERE id = ?`).get(matchId) as {
          state: string;
        }).state,
      ) as MatchState;
      const next = applyPoint(prev, winner); // 完赛后抛 MATCH_FINISHED
      const maxSeq = this.db
        .prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM points WHERE match_id = ?`)
        .get(matchId) as { m: number };
      const seq = maxSeq.m + 1;
      this.db
        .prepare(
          `INSERT INTO points(match_id, seq, request_id, winner, at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(matchId, seq, requestId, winner, at);
      this.db
        .prepare(`UPDATE matches SET state = ? WHERE id = ?`)
        .run(JSON.stringify(next), matchId);
      this.db.exec("COMMIT");
      return { state: next, duplicated: false, seq };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 撤销最近一分：删除最后事件 -> 全量重放 -> 更新快照，并写 undo_log。 */
  undo(matchId: string): { state: MatchState; removed: PointEvent } {
    const row = this.getMatchRow(matchId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db
        .prepare(
          `SELECT * FROM points WHERE match_id = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get(matchId) as
        | {
            seq: number;
            request_id: string;
            winner: Player;
            at: string;
          }
        | undefined;
      if (!last) {
        this.db.exec("ROLLBACK");
        throw new StoreError("EMPTY_HISTORY");
      }
      this.db
        .prepare(`DELETE FROM points WHERE match_id = ? AND seq = ?`)
        .run(matchId, last.seq);
      const { state } = this.replay(matchId, row.name_a, row.name_b);
      this.db
        .prepare(`UPDATE matches SET state = ? WHERE id = ?`)
        .run(JSON.stringify(state), matchId);
      this.db
        .prepare(
          `INSERT INTO undo_log(match_id, removed_seq, removed_request_id, removed_winner, at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          matchId,
          last.seq,
          last.request_id,
          last.winner,
          new Date().toISOString(),
        );
      this.db.exec("COMMIT");
      return {
        state,
        removed: {
          seq: last.seq,
          requestId: last.request_id,
          winner: last.winner,
          at: last.at,
        },
      };
    } catch (err) {
      if (err instanceof StoreError && err.code === "EMPTY_HISTORY") throw err;
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 逐分过程。 */
  listPoints(matchId: string): PointEvent[] {
    this.getMatchRow(matchId);
    const rows = this.db
      .prepare(
        `SELECT seq, request_id, winner, at FROM points
         WHERE match_id = ? ORDER BY seq ASC`,
      )
      .all(matchId) as Array<{
      seq: number;
      request_id: string;
      winner: Player;
      at: string;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      requestId: r.request_id,
      winner: r.winner,
      at: r.at,
    }));
  }

  undoLog(matchId: string) {
    this.getMatchRow(matchId);
    return this.db
      .prepare(
        `SELECT id, removed_seq, removed_request_id, removed_winner, at
         FROM undo_log WHERE match_id = ? ORDER BY id ASC`,
      )
      .all(matchId);
  }

  listMatches() {
    return this.db
      .prepare(`SELECT id, name_a, name_b, created_at FROM matches ORDER BY rowid`)
      .all();
  }

  /** 导出：比赛信息 + 事件 + 撤销记录。 */
  exportMatch(matchId: string) {
    const row = this.getMatchRow(matchId);
    const { state } = this.replay(matchId, row.name_a, row.name_b);
    return {
      id: row.id,
      names: { A: row.name_a, B: row.name_b },
      createdAt: row.created_at,
      state,
      points: this.listPoints(matchId),
      undoLog: this.undoLog(matchId),
    };
  }
}

export function defaultDbPath(): string {
  return resolve(process.cwd(), "data", "tennis.sqlite");
}
