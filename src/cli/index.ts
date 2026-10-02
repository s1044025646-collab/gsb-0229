#!/usr/bin/env node
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, StoreError } from "../db/store.js";
import { ScoreError, formatScore } from "../engine/engine.js";
import { Player } from "../engine/types.js";

function usage(): void {
  console.log(`网球逐分计分 CLI

用法:
  tennis init-db
  tennis create <选手A> <选手B>
  tennis list
  tennis point <比赛ID> <A|B> [requestId]     登记一分（requestId 省略则自动生成）
  tennis score <比赛ID>                       查询比分与状态
  tennis undo <比赛ID>                        撤销最近一分
  tennis history <比赛ID>                    查看逐分过程
  tennis undolog <比赛ID>                    查看撤销记录
  tennis export <比赛ID>                     导出完整记录(JSON)

环境变量:
  TENNIS_DB   SQLite 文件路径（默认 ./data/tennis.sqlite）
`);
}

function names(store: Store, id: string): Record<Player, string> {
  const { match } = store.getMatch(id);
  return { A: match.name_a, B: match.name_b };
}

function printScore(store: Store, id: string): void {
  const { state } = store.getMatch(id);
  const n = names(store, id);
  console.log(formatScore(state, n));
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    return 0;
  }
  const dbPath = process.env.TENNIS_DB ?? resolve(process.cwd(), "data", "tennis.sqlite");
  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case "init-db": {
        console.log(`数据库就绪: ${dbPath}`);
        return 0;
      }
      case "create": {
        const [a, b] = [argv[1], argv[2]];
        if (!a || !b || a === b) {
          console.error("错误: 需要两个不同的选手名字，例如 create 林岚 赵野");
          return 2;
        }
        const { id } = store.createMatch(a, b);
        console.log(`比赛已创建  id=${id}`);
        console.log(`${a} (A)  vs  ${b} (B)`);
        return 0;
      }
      case "list": {
        const rows = store.listMatches() as Array<Record<string, string>>;
        if (rows.length === 0) console.log("（暂无比赛）");
        for (const r of rows) {
          console.log(`${r.id}  ${r.name_a} vs ${r.name_b}  创建于 ${r.created_at}`);
        }
        return 0;
      }
      case "point": {
        const [id, who, rid] = [argv[1], argv[2], argv[3]];
        if (!id || (who !== "A" && who !== "B")) {
          console.error("错误: point <比赛ID> <A|B> [requestId]");
          return 2;
        }
        const requestId = rid ?? randomUUID();
        const result = store.addPoint(id, who as Player, requestId);
        const n = names(store, id);
        if (result.duplicated) {
          console.log(`重复请求（requestId=${requestId} 与第 ${result.seq} 分内容一致），未重复加分`);
        } else {
          console.log(`登记第 ${result.seq} 分，得分：${n[who as Player]} (${who})  [requestId=${requestId}]`);
        }
        printScore(store, id);
        return 0;
      }
      case "score": {
        if (!argv[1]) {
          console.error("错误: score <比赛ID>");
          return 2;
        }
        printScore(store, argv[1]);
        return 0;
      }
      case "undo": {
        if (!argv[1]) {
          console.error("错误: undo <比赛ID>");
          return 2;
        }
        const { removed } = store.undo(argv[1]);
        console.log(`已撤销第 ${removed.seq} 分（原得分 ${removed.winner}，requestId=${removed.requestId}）`);
        printScore(store, argv[1]);
        return 0;
      }
      case "history": {
        if (!argv[1]) {
          console.error("错误: history <比赛ID>");
          return 2;
        }
        const pts = store.listPoints(argv[1]);
        const n = names(store, argv[1]);
        if (pts.length === 0) console.log("（暂无得分记录）");
        for (const p of pts) {
          console.log(
            `#${String(p.seq).padStart(3, " ")}  ${p.at}  得分 ${p.winner} ${n[p.winner]}  requestId=${p.requestId}`,
          );
        }
        return 0;
      }
      case "undolog": {
        const log = store.undoLog(argv[1] ?? "") as Array<Record<string, unknown>>;
        if (log.length === 0) console.log("（暂无撤销记录）");
        for (const r of log) {
          console.log(`撤销第 ${r.removed_seq} 分（原得分 ${r.removed_winner}）at ${r.at}`);
        }
        return 0;
      }
      case "export": {
        if (!argv[1]) {
          console.error("错误: export <比赛ID>");
          return 2;
        }
        console.log(JSON.stringify(store.exportMatch(argv[1]), null, 2));
        return 0;
      }
      default: {
        console.error(`未知命令: ${cmd}`);
        usage();
        return 2;
      }
    }
  } catch (err) {
    if (err instanceof StoreError || err instanceof ScoreError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      return 1;
    }
    throw err;
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
