#!/usr/bin/env node
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, DEFAULT_DB_PATH } from './store.js';
import { describeState, gameLabel, type MatchState, type Side } from './engine.js';
import { startServer } from './server.js';

const args = process.argv.slice(2);
const command = args[0];

function usage(): never {
  console.log(`网球逐分计分服务（三盘两胜 / 占先制 / 6:6 抢七）

用法:
  tennis serve [--port 端口] [--db 路径]     启动 HTTP API（默认自动选空闲端口）
  tennis create <选手0> <选手1> [id]         创建比赛
  tennis point <比赛id> <0|1> <请求标识>      登记一分（0/1 为获胜选手）
  tennis state <比赛id>                      查询比分与状态
  tennis undo <比赛id>                       撤销最近一分
  tennis history <比赛id>                   查看逐分过程与审计记录
  tennis export <比赛id> [文件.json]         导出完整记录（不指定文件则打印）
  tennis demo                                运行内置演示（平分/抢七/终场撤销）
  tennis list                                列出所有比赛

数据默认存于项目内 ${DEFAULT_DB_PATH}`);
  process.exit(0);
}

function openStore(): Store {
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1]! : DEFAULT_DB_PATH;
  return new Store(resolve(dbPath));
}

function printState(state: MatchState): void {
  console.log(describeState(state));
}

async function main(): Promise<void> {
  switch (command) {
    case 'serve': {
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
      const dbIdx = args.indexOf('--db');
      const dbPath = resolve(dbIdx >= 0 ? args[dbIdx + 1]! : DEFAULT_DB_PATH);
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        console.error('端口必须是 1-65535 的整数');
        process.exit(1);
      }
      const { port: actual } = await startServer(port, dbPath);
      console.log(`HTTP API 已启动: http://127.0.0.1:${actual}`);
      console.log('按 Ctrl+C 退出');
      break;
    }

    case 'create': {
      const [, p0, p1, id] = args;
      if (!p0 || !p1) {
        console.error('需要两个选手名: tennis create <选手0> <选手1> [id]');
        process.exit(1);
      }
      const store = openStore();
      const matchId = id ?? `m_${Date.now().toString(36)}`;
      const state = store.createMatch(matchId, [p0, p1]);
      console.log(`比赛已创建 id=${matchId}`);
      printState(state);
      store.close();
      break;
    }

    case 'point': {
      const [, matchId, side, requestId] = args;
      if (!matchId || (side !== '0' && side !== '1') || !requestId) {
        console.error('用法: tennis point <比赛id> <0|1> <请求标识>');
        process.exit(1);
      }
      const store = openStore();
      try {
        const { state, replayed } = store.addPoint(matchId, Number(side) as Side, requestId);
        if (replayed) console.log('（重复请求，幂等返回，未重复加分）');
        printState(state);
      } catch (err) {
        reportError(err);
      } finally {
        store.close();
      }
      break;
    }

    case 'state': {
      const store = openStore();
      try {
        const { state } = store.getMatch(args[1] ?? '');
        printState(state);
      } catch (err) {
        reportError(err);
      } finally {
        store.close();
      }
      break;
    }

    case 'undo': {
      const store = openStore();
      try {
        const { state, undone } = store.undoPoint(args[1] ?? '');
        console.log(`已撤销第 ${undone.seq} 分（原胜方 ${undone.winner}）`);
        printState(state);
      } catch (err) {
        reportError(err);
      } finally {
        store.close();
      }
      break;
    }

    case 'history': {
      const store = openStore();
      try {
        const { points, audit } = store.getHistory(args[1] ?? '');
        console.log('--- 逐分记录 ---');
        for (const p of points) {
          console.log(`#${p.seq} 胜方=${p.winner} requestId=${p.requestId} at=${p.at}`);
        }
        console.log('--- 审计（含撤销） ---');
        for (const a of audit) {
          console.log(`[${a.kind}] ${a.detail} (${a.at})`);
        }
      } catch (err) {
        reportError(err);
      } finally {
        store.close();
      }
      break;
    }

    case 'export': {
      const store = openStore();
      try {
        const matchId = args[1];
        if (!matchId) {
          console.error('用法: tennis export <比赛id> [文件.json]');
          process.exit(1);
        }
        const { state, players } = store.getMatch(matchId);
        const { history } = { history: store.getHistory(matchId) };
        const payload = {
          matchId,
          players,
          exportedAt: new Date().toISOString(),
          state,
          text: describeState(state),
          points: history.points,
          audit: history.audit,
        };
        const json = JSON.stringify(payload, null, 2);
        if (args[2]) {
          writeFileSync(resolve(args[2]), json, 'utf8');
          console.log(`已导出到 ${resolve(args[2])}`);
        } else {
          console.log(json);
        }
      } catch (err) {
        reportError(err);
      } finally {
        store.close();
      }
      break;
    }

    case 'list': {
      const store = openStore();
      for (const m of store.listMatches()) {
        console.log(`${m.id}  ${m.players[0]} vs ${m.players[1]}  ${m.winner === null ? '进行中' : `已结束(${m.players[m.winner]}胜)`}`);
      }
      store.close();
      break;
    }

    case 'demo':
      runDemo();
      break;

    default:
      usage();
  }
}

function reportError(err: unknown): never {
  const code = (err as { code?: string }).code ?? 'INTERNAL_ERROR';
  console.error(`错误 [${code}]: ${(err as Error).message}`);
  process.exit(1);
}

/**
 * 内置演示（不依赖数据库文件，直接跑引擎）：
 * 1) 普通局反复平分与占先丢失；2) 一个完整抢七；3) 决胜分后撤销使比赛重新开放。
 */
function runDemo(): void {
  const players: [string, string] = ['林岚', '陈野'];
  const demoDb = resolve('data/demo.db');
  rmSync(demoDb, { force: true });
  rmSync(demoDb + '-wal', { force: true });
  rmSync(demoDb + '-shm', { force: true });
  const store = new Store(demoDb);
  store.createMatch('demo', players);
  let state = store.getMatch('demo').state;
  let step = 0;
  let requestSeq = 0;
  const feed = (seq: Side[], note: string): void => {
    console.log(`\n=== ${note} ===`);
    for (const winner of seq) {
      requestSeq += 1;
      const { state: next } = store.addPoint('demo', winner, `demo-req-${requestSeq}`);
      state = next;
      const current = state.sets[state.sets.length - 1]!;
      step += 1;
      const where = current.tiebreak ? `抢七 ${current.tiebreak[0]}:${current.tiebreak[1]}` : `局 ${gameLabel(state.game, players)}`;
      console.log(`第${step}分 -> ${players[winner]} | 盘分 ${current.games[0]}:${current.games[1]} | ${where}`);
    }
  };

  // 第 1 盘：先打出一局 40:40 后多次平分、占先丢失再保发
  // 3:3=40:40，甲占先，乙追回平分，乙占先，甲追回平分，甲连得两分赢局
  feed([0, 0, 0, 1, 1, 1], '普通局：打到 40:40 平分');
  feed([0], '甲占先');
  feed([1], '乙追回，重新平分（占先丢失）');
  feed([1], '乙占先');
  feed([0], '甲追回，再次平分');
  feed([0, 1, 0, 0], '甲赢下拉锯局（比分 1:0）');

  // 快速打到 5:5（双方各再赢 5 局：甲5乙5，加上甲已有1局 => 需要甲再赢4局、乙赢5局）
  feed(quickGames(0, 4), '甲连续保发，5:0 小高潮后的调整');
  feed(quickGames(1, 5), '乙连追，局分来到 5:5');
  feed(quickGames(0, 1), '甲 6:5 —— 领先仅一局，比赛继续');
  feed(quickGames(1, 1), '乙 6:6，进入抢七');

  // 抢七：打到 6:6 继续、7:6 继续、8:6 结束
  feed([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], '抢七 6:6（须领先两分，继续）');
  feed([0], '抢七 7:6 —— 仍未结束');
  feed([0], '抢七 8:6，甲赢下第 1 盘');

  console.log('\n当前比分：');
  console.log(describeState(state));
  // 第 2 盘：乙 6:4（用占先外的普通局速通，盘分 1:1）
  feed(quickGames(0, 4), '第 2 盘甲 4:0 领先');
  feed(quickGames(1, 6), '乙连下六局，6:4 赢下第 2 盘，盘分 1:1');

  // 第 3 盘：甲打到 5:0
  feed(quickGames(0, 5), '第 3 盘甲 5:0');
  console.log('\n--- 冠军点前 ---');
  console.log(describeState(state));
  feed([0, 0, 0], '冠军局 40:0');
  console.log('\n--- 登记最后一分（冠军点） ---');
  feed([0], '甲赢下比赛！');
  console.log(describeState(state));

  console.log('\n--- 比赛结束后尝试再记分（应被拒绝） ---');
  try {
    store.addPoint('demo', 0, 'after-finish');
  } catch (err) {
    console.log(`如预期拒绝: [${(err as { code: string }).code}] ${(err as Error).message}`);
  }

  console.log('\n--- 撤销冠军点：比赛应重新开放，比分回到 40:0 ---');
  const { state: reopened, undone } = store.undoPoint('demo');
  state = reopened;
  console.log(`已撤销第 ${undone.seq} 分，比赛重新开放：`);
  console.log(describeState(state));

  console.log('\n--- 再登记一分（新请求标识），比赛再次结束 ---');
  requestSeq += 1;
  state = store.addPoint('demo', 0, `demo-req-${requestSeq}`).state;
  console.log(describeState(state));

  console.log('\n--- 空历史撤销检查：对新比赛撤销应报错（见测试） ---');
  store.close();
  console.log('演示结束。数据库文件：' + demoDb + "（可用 `tennis history demo --db " + demoDb + '` 查看全过程）');
}

/** 一方连赢 games 个普通局（每局 4 分）。 */
function quickGames(winner: Side, games: number): Side[] {
  return Array(games * 4).fill(winner) as Side[];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
