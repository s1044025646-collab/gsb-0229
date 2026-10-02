/**
 * 端到端演示：
 * 1) 普通局反复平分、占先丢失；
 * 2) 6-6 抢七，7-6 后继续，8-6 结束该盘；
 * 3) 第二盘打完，整场结束，再记分被拒绝；
 * 4) 撤销决胜分，比赛重新开放；
 * 5) 导出逐分过程。
 * 直接操作本地 SQLite（与 CLI、服务端共用同一存储层）。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db/store.js";
import { formatScore } from "../src/engine/engine.js";
import { Player } from "../src/engine/types.js";

const dbPath = join(process.cwd(), "data", "demo.sqlite");
for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

const store = new Store(dbPath);
const { id } = store.createMatch("林岚", "赵野");
const names = { A: "林岚", B: "赵野" } as const;

let req = 0;
const point = (w: Player, label?: string): void => {
  const requestId = `demo-${++req}`;
  const r = store.addPoint(id, w, requestId);
  console.log(
    `\n── ${label ?? `第 ${r.seq} 分：${names[w]} 得分`}（requestId=${requestId}）`,
  );
  console.log(formatScore(store.getMatch(id).state, names));
};

const hold = (w: Player, n = 4, label?: string): void => {
  for (let i = 0; i < n; i++) point(w, i === n - 1 ? label : undefined);
};

console.log("=== 场景 1：普通局反复平分，占先丢失 ===");
point("A"); point("A"); point("A");           // 林岚 40-0
point("B"); point("B"); point("B");           // 追成平分
point("A", "林岚占先");
point("B", "赵野扳回，重新平分（占先丢失）");
point("B", "赵野占先");
point("B", "赵野破发成功，赢下第 1 局");

console.log("\n=== 推进到 6-6（互保发球局）===");
// 当前局分 0-1（赵野领先）；交错保发，林岚追成 1-1、2-2 …直到 6-6
for (let g = 0; g < 6; g++) {
  hold("A", 4, g === 5 ? "林岚保发，局分 6-6，进入抢七" : "林岚保发一局");
  if (g < 5) hold("B", 4, "赵野保发一局");
}

console.log("\n=== 场景 2：抢七 7-6 继续，8-6 结束该盘 ===");
for (let i = 0; i < 6; i++) {
  point("A");
  point("B");
}
point("A", "抢七 7-6：只领先 1 分，比赛继续（不结束）");
console.log("\n-- 撤销这 1 分，回到 6-6，重新打到 8-6 --");
store.undo(id);
point("A");
point("A", "抢七 8-6：领先两分，林岚赢下抢七与该盘（局分 7-6）");

console.log("\n=== 场景 3：第二盘，林岚 6-0 横扫，整场结束 ===");
for (let g = 0; g < 6; g++) hold("A", 4, "林岚保发（第二盘）");

console.log("\n=== 完赛后再记分：应被拒绝 ===");
try {
  store.addPoint(id, "A", "demo-after-finish");
  console.log("错误：不应该记分成功！");
} catch (e) {
  console.log(`按预期拒绝记分：${(e as Error).message}`);
}

console.log("\n=== 场景 4：撤销决胜分，比赛重新开放 ===");
const undone = store.undo(id);
console.log(`已撤销第 ${undone.removed.seq} 分`);
console.log(formatScore(undone.state, names));

console.log("\n=== 逐分过程（前 10 与后 5）===");
const pts = store.listPoints(id);
for (const p of pts.slice(0, 10)) {
  console.log(`#${p.seq} ${names[p.winner]} ${p.requestId}`);
}
console.log("...");
for (const p of pts.slice(-5)) {
  console.log(`#${p.seq} ${names[p.winner]} ${p.requestId}`);
}
console.log(`\n当前共 ${pts.length} 分；数据库文件：${dbPath}`);

store.close();
