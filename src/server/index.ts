import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, StoreError } from "../db/store.js";
import { ScoreError } from "../engine/engine.js";
import { Player } from "../engine/types.js";

interface AppContext {
  store: Store;
}

const ERROR_STATUS: Record<string, number> = {
  MATCH_NOT_FOUND: 404,
  EMPTY_HISTORY: 409,
  DUPLICATE_REQUEST: 409,
  MATCH_FINISHED: 409,
  INVALID_PLAYER: 400,
  BAD_NAMES: 400,
  VALIDATION: 400,
  NOT_FOUND: 404,
  BAD_STATE: 500,
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolvePromise, rejectPromise) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) rejectPromise(new Error("BODY_TOO_LARGE"));
    });
    req.on("end", () => {
      if (!data) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(data));
      } catch {
        rejectPromise(new Error("INVALID_JSON"));
      }
    });
    req.on("error", rejectPromise);
  });
}

function asNames(body: any): { nameA: string; nameB: string } {
  const nameA = String(body?.nameA ?? "").trim();
  const nameB = String(body?.nameB ?? "").trim();
  if (!nameA || !nameB || nameA === nameB || nameA.length > 40 || nameB.length > 40) {
    throw new ScoreError("BAD_NAMES");
  }
  return { nameA, nameB };
}

function asPoint(body: any): { winner: Player; requestId: string } {
  const winner = body?.winner;
  if (winner !== "A" && winner !== "B") {
    const e = new Error("VALIDATION") as Error & { code: string };
    e.code = "VALIDATION";
    throw e;
  }
  let requestId = body?.requestId;
  if (requestId === undefined || requestId === null || requestId === "") {
    requestId = randomUUID(); // 未提供时服务端生成，仍可幂等由客户端负责
  }
  requestId = String(requestId);
  if (requestId.length > 100) {
    const e = new Error("VALIDATION") as Error & { code: string };
    e.code = "VALIDATION";
    throw e;
  }
  return { winner, requestId };
}

function matchView(
  ctx: AppContext,
  id: string,
): { id: string; names: { A: string; B: string }; state: ReturnType<Store["getMatch"]>["state"] } {
  const { match, state } = ctx.store.getMatch(id);
  return { id, names: { A: match.name_a, B: match.name_b }, state };
}

async function handler(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  try {
    // GET /health
    if (method === "GET" && path === "/health") {
      return send(res, 200, { ok: true });
    }

    // POST /matches
    if (method === "POST" && path === "/matches") {
      const body = await readJson(req);
      const { nameA, nameB } = asNames(body);
      const created = ctx.store.createMatch(nameA, nameB);
      return send(res, 201, {
        id: created.id,
        names: { A: nameA, B: nameB },
        state: created.state,
      });
    }

    // GET /matches
    if (method === "GET" && path === "/matches") {
      return send(res, 200, { matches: ctx.store.listMatches() });
    }

    const m = path.match(/^\/matches\/([^/]+)(\/points|\/undo|\/export)?$/);
    if (!m) {
      return send(res, 404, { error: { code: "NOT_FOUND", message: path } });
    }
    const id = decodeURIComponent(m[1]!);
    const action = m[2] ?? "";

    // GET /matches/:id
    if (method === "GET" && action === "") {
      return send(res, 200, matchView(ctx, id));
    }

    // POST /matches/:id/points
    if (method === "POST" && action === "/points") {
      const body = await readJson(req);
      const { winner, requestId } = asPoint(body);
      const result = ctx.store.addPoint(id, winner, requestId);
      const view = matchView(ctx, id);
      return send(res, result.duplicated ? 200 : 201, {
        ...view,
        applied: !result.duplicated,
        duplicated: result.duplicated,
        requestId,
        seq: result.seq,
      });
    }

    // POST /matches/:id/undo
    if (method === "POST" && action === "/undo") {
      const result = ctx.store.undo(id);
      return send(res, 200, {
        ...matchView(ctx, id),
        removed: result.removed,
      });
    }

    // GET /matches/:id/export
    if (method === "GET" && action === "/export") {
      return send(res, 200, ctx.store.exportMatch(id));
    }

    return send(res, 404, { error: { code: "NOT_FOUND", message: path } });
  } catch (err) {
    const code =
      err instanceof StoreError || err instanceof ScoreError
        ? err.code
        : (err as { code?: string }).code === "VALIDATION"
          ? "VALIDATION"
          : (err as Error).message === "INVALID_JSON"
            ? "VALIDATION"
            : (err as Error).message === "BODY_TOO_LARGE"
              ? "VALIDATION"
              : "INTERNAL";
    const status = ERROR_STATUS[code] ?? 500;
    return send(res, status, {
      error: {
        code: code === "INTERNAL" ? "INTERNAL" : code,
        message: (err as Error).message,
      },
    });
  }
}

/** 请求系统分配一个空闲 TCP 端口（端口 0）。 */
function listenOnFree(
  server: ReturnType<typeof createServer>,
  preferredPort: number,
): Promise<number> {
  return new Promise((resPromise, rejPromise) => {
    server.once("error", rejPromise);
    server.listen(preferredPort, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resPromise(addr.port);
      else rejPromise(new Error("NO_PORT"));
    });
  });
}

export async function startServer(options?: {
  port?: number;
  dbPath?: string;
}): Promise<{ port: number; close: () => void; store: Store }> {
  const dbPath =
    options?.dbPath ?? resolve(process.cwd(), "data", "tennis.sqlite");
  const store = new Store(dbPath);
  const ctx: AppContext = { store };
  const server = createServer((req, res) => {
    void handler(ctx, req, res);
  });
  const port = await listenOnFree(server, options?.port ?? 0);
  return {
    port,
    close: () => {
      server.close();
      store.close();
    },
    store,
  };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const preferred = Number(process.env.PORT ?? 0);
  startServer({ port: Number.isFinite(preferred) ? preferred : 0 }).then(
    ({ port }) => {
      console.log(`网球计分服务已启动: http://127.0.0.1:${port}`);
      console.log("可用端点: POST /matches, POST /matches/:id/points,");
      console.log("  GET /matches/:id, POST /matches/:id/undo, GET /matches/:id/export");
    },
  );
}
