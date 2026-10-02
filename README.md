# 网球逐分计分与撤销回放服务（本地后端）

一个只做 **API + CLI** 的本地网球单打计分服务。逐分登记获胜者，实时给出局、盘和整场比分；可撤销最近一分并恢复到正确状态（自动跨越赢局、赢盘、比赛结束边界）。

- 语言/运行时：TypeScript + Node.js（要求 Node ≥ 22.5，开发验证版本 Node 25.5）
- 数据库：SQLite，使用 Node **内置**的 `node:sqlite`（无需本地编译、无需任何第三方数据库依赖）
- 纯本地运行：不依赖 Docker、WSL、付费服务或外部在线 API

## 赛制与限定

- 单打，**三盘两胜**，选手为虚构人物（任意两个不同名字）。
- 普通局采用**占先制**：比分展示 0 / 15 / 30 / 40 / 平分(Deuce) / 占先(Advantage)，一方至少 4 分且**领先 2 分**才赢下该局；占先被扳回则重新平分。
- 一盘：先到 **6 局且领先 2 局**获胜（6-0…6-4、7-5）；
  **6-6 进入七分抢七**，抢七先到 7 分且**领先 2 分**获胜（可能 8-6、9-7……），抢七胜者以 **7-6** 赢下该盘；抢七结束后下一盘自动恢复普通局。
- 赢下两盘整场结束，结束后再登记分数会被拒绝（错误码 `MATCH_FINISHED`）。
- 撤销只针对**最近一个有效分**：删除该事件后从全部事件重放重建状态，因此能正确回退赢局/赢盘/完赛边界。不支持修改任意历史分、不支持分支对比。
- 不处理：发球轮换、双打、弃权/退赛、赛事排名、真实比赛数据采集、图形计分牌。

## 核心设计

- 计分引擎 `src/engine/` 是纯函数：`applyPoint(状态, 得分方) -> 新状态`，事件重放与实时记分走同一条逻辑。
- SQLite（`src/db/store.ts`）：
  - 表 `matches`（含当前状态快照 JSON）、`points`（逐分事件，`request_id` 全局唯一）、`undo_log`（撤销记录）。
  - 每次记分在一个事务里**同时写入事件和更新快照**；快照只是缓存，权威数据是事件。
  - 查询时用事件重放并与快照核对，不一致报 `BAD_STATE`。
  - 撤销 = 删除最后事件 → 全量重放 → 更新快照，并写 `undo_log`。
  - **幂等**：同一 `requestId` + 相同 `winner` 视为重复，返回 `duplicated: true` 且不加分；同一 `requestId` 但不同 `winner` 返回 409 `DUPLICATE_REQUEST`（冲突）。

## 目录结构

```
src/engine/   纯计分引擎（状态机、比分展示、重放）
src/db/       SQLite 存储（事件、快照、撤销、导出）
src/server/   HTTP API（node:http，无第三方框架）
src/cli/      命令行工具
tests/        node:test 测试（引擎规则、存储/重放、HTTP API）
demos/        端到端演示脚本
data/         SQLite 数据目录（运行时自动创建）
```

## 安装与构建

```powershell
npm install
npm run build
```

## 一键命令

| 用途 | 命令 |
| --- | --- |
| 构建 | `npm run build` |
| 测试 | `npm test` |
| 端到端演示（平分/抢七/完赛撤销） | `npm run demo` |
| 启动 API 服务（生产，需先 build） | `npm start` |
| 启动 API 服务（TS 直跑） | `npm run dev` |
| CLI（TS 直跑） | `npm run cli -- <命令...>` |

## API 服务

启动默认绑定 `127.0.0.1` 并由系统分配**空闲端口**（端口 0），启动日志会打印实际端口。
需要固定端口时设置环境变量 `PORT`：

```powershell
$env:PORT=8080
npm start
```

### 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET`  | `/health` | 健康检查 |
| `POST` | `/matches` | 创建比赛，body：`{"nameA":"林岚","nameB":"赵野"}` |
| `GET`  | `/matches` | 列出比赛 |
| `GET`  | `/matches/:id` | 查询比分与状态 |
| `POST` | `/matches/:id/points` | 登记一分，body：`{"winner":"A","requestId":"uuid-..."}` |
| `POST` | `/matches/:id/undo` | 撤销最近一分 |
| `GET`  | `/matches/:id/export` | 导出比赛信息 + 全部事件 + 撤销记录（JSON） |

`winner` 只能是 `"A"` 或 `"B"`；`requestId` 建议客户端提供（≤100 字符），省略时服务端生成。

### 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION` | 请求体非法（非 JSON、winner 非法、requestId 过长等） |
| 400 | `BAD_NAMES` | 选手名字为空、相同或过长 |
| 404 | `MATCH_NOT_FOUND` / `NOT_FOUND` | 比赛或路径不存在 |
| 409 | `DUPLICATE_REQUEST` | 同一 requestId 携带了不同 winner（冲突） |
| 409 | `EMPTY_HISTORY` | 没有可撤销的分 |
| 409 | `MATCH_FINISHED` | 比赛已结束，拒绝继续记分 |
| 500 | `BAD_STATE` / `INTERNAL` | 快照与事件重放不一致 / 服务器内部错误 |

错误响应统一为：`{"error":{"code":"...","message":"..."}}`。

### curl/PowerShell 示例

```powershell
$base = "http://127.0.0.1:8080"
$m = Invoke-RestMethod "$base/matches" -Method Post -ContentType 'application/json' -Body '{"nameA":"林岚","nameB":"赵野"}'
Invoke-RestMethod "$base/matches/$($m.id)/points" -Method Post -ContentType 'application/json' -Body '{"winner":"A","requestId":"p-1"}'
Invoke-RestMethod "$base/matches/$($m.id)"           # 查询
Invoke-RestMethod "$base/matches/$($m.id)/undo" -Method Post
```

## CLI

CLI 直接读写本地 SQLite（默认 `./data/tennis.sqlite`，可用环境变量 `TENNIS_DB` 覆盖）。

```powershell
npm run build

node dist/cli/index.js create 林岚 赵野
node dist/cli/index.js list
node dist/cli/index.js point <比赛ID> A my-req-001   # A 得分（可带 requestId）
node dist/cli/index.js score <比赛ID>                # 查看比分
node dist/cli/index.js undo <比赛ID>                 # 撤销最近一分
node dist/cli/index.js history <比赛ID>              # 逐分过程
node dist/cli/index.js undolog <比赛ID>              # 撤销记录
node dist/cli/index.js export <比赛ID>               # JSON 导出
```

比分输出示例（占先、抢七、完赛）：

```
第1盘 局分 6:6  | 抢七 7:6（林岚 : 赵野）
第1盘 7:6（抢七 8:6） 胜：林岚
比赛结束，冠军：林岚
```

## 测试覆盖

`npm test` 使用 Node 内置测试运行器，覆盖：

- 占先制：平分、占先、占先丢失回平分、领先两球才赢局；
- 盘：6-5 继续、7-5 赢盘、6-4 赢盘；
- 抢七：6-6 进入、7-6 继续、8-6 结束并以 7-6 记盘、下盘恢复普通局；
- 赢两盘后拒绝记分；
- 撤销：决胜分撤销后比赛重新开放、跨赢局/赢盘/完赛边界与重放一致、连续撤销、空历史报错；
- 幂等：重复 requestId 不重复加分、冲突内容报错；
- 重启后重新打开数据库，事件重放结果与快照一致；
- HTTP API 全流程状态码与响应。

## 已知限制（合理假设）

- 单机单进程使用；SQLite 写事务保证进程内并发安全，未做多实例协调。
- 撤销使用“删除最后事件 + 全量重放”，万分级数据量下足够；未做增量快照优化。
- `node:sqlite` 在当前 Node 版本会打印一条 `ExperimentalWarning`，不影响功能。
- 不记录发球人/换边、不校验选手实名，仅按 A/B 两方记分。
