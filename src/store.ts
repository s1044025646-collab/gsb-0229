import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  createMatch,
  replay,
  type MatchState,
  type PointEvent,
  type Side,
} from './engine.js';

export class StoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

interface MatchRow {
  id: string;
  player0: string;
  player1: string;
  state: string;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY,
        player0 TEXT NOT NULL,
        player1 TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL REFERENCES matches(id),
        seq INTEGER NOT NULL,
        winner INTEGER NOT NULL CHECK (winner IN (0,1)),
        request_id TEXT NOT NULL,
        at TEXT NOT NULL,
        UNIQUE (match_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        request_id TEXT,
        detail TEXT NOT NULL,
        at TEXT NOT NULL
      );
    `);
  }

  createMatch(id: string, players: [string, string]): MatchState {
    const state = createMatch(players);
    const at = new Date().toISOString();
    try {
      this.db
        .prepare(
          `INSERT INTO matches (id, player0, player1, state, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, players[0], players[1], JSON.stringify(state), at);
      this.db
        .prepare(`INSERT INTO audit_log (match_id, kind, request_id, detail, at) VALUES (?, 'CREATE', NULL, ?, ?)`)
        .run(id, `创建比赛：${players[0]} vs ${players[1]}`, at);
    } catch (err) {
      if ((err as Error).message?.includes('UNIQUE')) {
        throw new StoreError('MATCH_ID_CONFLICT', `比赛 ID 已存在：${id}`);
      }
      throw err;
    }
    return state;
  }

  getMatch(id: string): { state: MatchState; players: [string, string] } {
    const row = this.db.prepare(`SELECT * FROM matches WHERE id = ?`).get(id) as
      | MatchRow
      | undefined;
    if (!row) throw new StoreError('MATCH_NOT_FOUND', `比赛不存在：${id}`);
    return {
      state: JSON.parse(row.state) as MatchState,
      players: [row.player0, row.player1],
    };
  }

  listMatches(): Array<{ id: string; players: [string, string]; winner: Side | null }> {
    const rows = this.db
      .prepare(`SELECT id, player0, player1, state FROM matches ORDER BY created_at`)
      .all() as Array<{ id: string; player0: string; player1: string; state: string }>;
    return rows.map((r) => ({
      id: r.id,
      players: [r.player0, r.player1],
      winner: (JSON.parse(r.state) as MatchState).winner,
    }));
  }

  private getPoints(matchId: string): PointEvent[] {
    const rows = this.db
      .prepare(`SELECT seq, winner, request_id, at FROM points WHERE match_id = ? ORDER BY seq`)
      .all(matchId) as Array<{ seq: number; winner: number; request_id: string; at: string }>;
    return rows.map((r) => ({ seq: r.seq, winner: r.winner as Side, requestId: r.request_id, at: r.at }));
  }

  /**
   * 登记一分：在一个事务内完成“幂等校验 + 写事件 + 重放校验 + 状态提交 + 审计”。
   * 事件为唯一事实来源，当前状态由事件重放得到后一并落库。
   */
  addPoint(matchId: string, winner: Side, requestId: string): { state: MatchState; replayed: boolean; conflict?: string } {
    this.getMatch(matchId); // 存在性校验
    const at = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db
        .prepare(`SELECT winner FROM points WHERE match_id = ? AND request_id = ?`)
        .get(matchId, requestId) as { winner: number } | undefined;
      if (existing) {
        if (existing.winner !== winner) {
          throw new StoreError(
            'REQUEST_CONFLICT',
            `请求标识 ${requestId} 已用于另一方获胜（记录为 ${existing.winner}，本次为 ${winner}）`,
          );
        }
        const state = this.getMatch(matchId).state;
        this.db.exec('COMMIT');
        return { state, replayed: true as const };
      }
      const points = this.getPoints(matchId);
      const seq = points.length + 1;
      this.db
        .prepare(`INSERT INTO points (match_id, seq, winner, request_id, at) VALUES (?, ?, ?, ?, ?)`)
        .run(matchId, seq, winner, requestId, at);
      const { player0, player1 } = this.db
        .prepare(`SELECT player0, player1 FROM matches WHERE id = ?`)
        .get(matchId) as { player0: string; player1: string };
      const nextEvents: PointEvent[] = [...points, { seq, winner, requestId, at }];
      let state: MatchState;
      try {
        state = replay([player0, player1], nextEvents);
      } catch (err) {
        throw new StoreError('MATCH_FINISHED', (err as Error).message);
      }
      this.db.prepare(`UPDATE matches SET state = ? WHERE id = ?`).run(JSON.stringify(state), matchId);
      this.db
        .prepare(`INSERT INTO audit_log (match_id, kind, request_id, detail, at) VALUES (?, 'POINT', ?, ?, ?)`)
        .run(matchId, requestId, `第 ${seq} 分，胜方 ${winner === 0 ? player0 : player1}`, at);
      this.db.exec('COMMIT');
      return { state, replayed: false as const };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 撤销最近一分：删除最后一条事件后重放并提交。无历史时抛错。 */
  undoPoint(matchId: string): { state: MatchState; undone: PointEvent } {
    this.getMatch(matchId);
    const at = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const points = this.getPoints(matchId);
      if (points.length === 0) {
        throw new StoreError('EMPTY_HISTORY', '没有可撤销的得分记录');
      }
      const last = points[points.length - 1]!;
      this.db.prepare(`DELETE FROM points WHERE match_id = ? AND seq = ?`).run(matchId, last.seq);
      const { player0, player1 } = this.db
        .prepare(`SELECT player0, player1 FROM matches WHERE id = ?`)
        .get(matchId) as { player0: string; player1: string };
      const state = replay([player0, player1], points.slice(0, -1));
      this.db.prepare(`UPDATE matches SET state = ? WHERE id = ?`).run(JSON.stringify(state), matchId);
      this.db
        .prepare(`INSERT INTO audit_log (match_id, kind, request_id, detail, at) VALUES (?, 'UNDO', ?, ?, ?)`)
        .run(matchId, last.requestId, `撤销第 ${last.seq} 分（原胜方 ${last.winner === 0 ? player0 : player1}）`, at);
      this.db.exec('COMMIT');
      return { state, undone: last };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getHistory(matchId: string): { points: PointEvent[]; audit: Array<{ kind: string; detail: string; at: string }> } {
    const { players } = this.getMatch(matchId);
    const points = this.getPoints(matchId);
    const audit = this.db
      .prepare(`SELECT kind, detail, at FROM audit_log WHERE match_id = ? ORDER BY id`)
      .all(matchId) as Array<{ kind: string; detail: string; at: string }>;
    void players;
    return { points, audit };
  }

  close(): void {
    this.db.close();
  }
}

export const DEFAULT_DB_PATH = 'data/tennis.db';
