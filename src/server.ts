import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { Store, StoreError, DEFAULT_DB_PATH } from './store.js';
import { describeState, type Side } from './engine.js';

export interface ApiError {
  code: string;
  message: string;
}

const ERROR_STATUS: Record<string, number> = {
  MATCH_NOT_FOUND: 404,
  MATCH_FINISHED: 409,
  REQUEST_CONFLICT: 409,
  EMPTY_HISTORY: 409,
  MATCH_ID_CONFLICT: 409,
  VALIDATION_ERROR: 400,
};

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('无法获取空闲端口'));
      }
    });
  });
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'VALIDATION_ERROR' });
  }
}

function requirePlayer(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw Object.assign(new Error(`字段 ${field} 必须是非空字符串`), { code: 'VALIDATION_ERROR' });
  }
  if (value.length > 32) {
    throw Object.assign(new Error(`字段 ${field} 长度不能超过 32`), { code: 'VALIDATION_ERROR' });
  }
  return value.trim();
}

function parseSide(value: unknown): Side {
  if (value !== 0 && value !== 1 && value !== '0' && value !== '1') {
    throw Object.assign(new Error('字段 winner 必须为 0 或 1'), { code: 'VALIDATION_ERROR' });
  }
  return Number(value) as Side;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

export async function startServer(port?: number, dbPath: string = DEFAULT_DB_PATH): Promise<{ server: Server; port: number; store: Store }> {
  const store = new Store(dbPath);
  const actualPort = port ?? (await pickFreePort());

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        send(res, 200, { ok: true });
        return;
      }

      if (method === 'POST' && path === '/matches') {
        const body = (await readJson(req)) as Record<string, unknown>;
        const provided = Array.isArray(body.players) ? (body.players as unknown[]) : [];
        const players: [string, string] = [
          requirePlayer(body.player0 ?? provided[0], 'player0'),
          requirePlayer(body.player1 ?? provided[1], 'player1'),
        ];
        if (players[0] === players[1]) {
          throw Object.assign(new Error('两位选手不能同名'), { code: 'VALIDATION_ERROR' });
        }
        const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomId();
        const state = store.createMatch(id, players);
        send(res, 201, { id, state, text: describeState(state) });
        return;
      }

      if (method === 'GET' && path === '/matches') {
        send(res, 200, { matches: store.listMatches() });
        return;
      }

      const pointMatch = path.match(/^\/matches\/([^/]+)\/points$/);
      if (pointMatch && method === 'POST') {
        const matchId = decodeURIComponent(pointMatch[1]!);
        const body = (await readJson(req)) as Record<string, unknown>;
        const winner = parseSide(body.winner);
        if (typeof body.requestId !== 'string' || body.requestId.trim().length === 0) {
          throw Object.assign(new Error('字段 requestId 必须是非空字符串（幂等键）'), { code: 'VALIDATION_ERROR' });
        }
        const { state, replayed } = store.addPoint(matchId, winner, body.requestId.trim());
        send(res, replayed ? 200 : 201, {
          state,
          text: describeState(state),
          idempotentReplay: replayed,
        });
        return;
      }

      const undoMatch = path.match(/^\/matches\/([^/]+)\/undo$/);
      if (undoMatch && method === 'POST') {
        const matchId = decodeURIComponent(undoMatch[1]!);
        const { state, undone } = store.undoPoint(matchId);
        send(res, 200, { state, text: describeState(state), undone });
        return;
      }

      const stateMatch = path.match(/^\/matches\/([^/]+)\/state$/);
      if (stateMatch && method === 'GET') {
        const matchId = decodeURIComponent(stateMatch[1]!);
        const { state } = store.getMatch(matchId);
        send(res, 200, { state, text: describeState(state) });
        return;
      }

      const historyMatch = path.match(/^\/matches\/([^/]+)\/history$/);
      if (historyMatch && method === 'GET') {
        const matchId = decodeURIComponent(historyMatch[1]!);
        const history = store.getHistory(matchId);
        const { state, players } = store.getMatch(matchId);
        send(res, 200, { matchId, players, history, state, text: describeState(state) });
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${method} ${path}` } satisfies ApiError });
    } catch (err) {
      const code = (err as { code?: string }).code ?? (err instanceof StoreError ? err.code : 'INTERNAL_ERROR');
      const message = (err as Error).message || '内部错误';
      const status = ERROR_STATUS[code] ?? 500;
      send(res, status, { error: { code, message } satisfies ApiError });
    }
  });

  await new Promise<void>((resolve) => server.listen(actualPort, '127.0.0.1', resolve));
  return { server, port: actualPort, store };
}
