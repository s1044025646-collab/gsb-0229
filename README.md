# 网球逐分计分与撤销回放后端（本地）

使用 **TypeScript + Node.js + SQLite** 实现的本地网球单打计分服务，只提供 HTTP API 与命令行（CLI），无图形界面。
选手均为虚构，不采集任何真实比赛数据，不依赖 Docker、WSL、付费服务或外部在线 API。

## 赛制与限定

- 三盘两胜（Best of 3），赢下两盘整场结束，结束后拒绝继续记分。
- 普通局为**占先制**：0/15/30/40，40:40 为平分（deuce），一方占先（advantage）后须再得一分；占先方失分则回到平分；净胜两分才赢局。
- 一盘：先赢 6 局且净胜 2 局获胜（6:0～6:4、7:5）。
- 局分 6:6 进入**七分抢七**：先到 7 分且净胜 2 分获胜（故 7:6 不结束，可能打到 8:6、9:7……）。
- 抢七结束后下一盘**自动恢复普通局**计分。
- 不处理：发球轮换/发球权、双打、弃权（退赛）、赛事排名、真实数据采集、任意历史分修改、分支对比。

## 核心设计

- **事件溯源**：每次有效记分写入一条不可变的逐分事件（`points` 表）。当前比分状态由全部有效事件**重放**得到，事件与状态在同一个 SQLite 事务中提交（`BEGIN IMMEDIATE` … `COMMIT`）。
- **撤销**：只允许撤销最近一条有效得分——删除最后一条事件后重新重放。因此可以正确跨越“赢局 / 进入抢七 / 赢盘 / 比赛结束”边界，不会只把计数减一而留下错误状态。撤销动作本身写入审计日志。
- **请求标识（幂等键）**：每次记分必须带 `requestId`。同一 `(比赛, requestId)` 重复提交不会重复加分；若同一 `requestId` 携带了不同的获胜方，返回 `409 REQUEST_CONFLICT`。
- SQLite 使用 Node.js 内置模块 `node:sqlite`（Node ≥ 22.5，建议 Node 24/25），**无需原生编译、无需 node-gyp 或 Visual Studio Build Tools**。
- 数据库文件默认放在项目内 `data/tennis.db`（WAL 模式）。

## 环境要求

- Windows 10/11，PowerShell。
- Node.js 22.5 以上（开发验证版本：**v25.5.0**，npm 11）。

## 安装、构建、测试、启动、演示

```powershell
npm install        # 仅安装 typescript 与类型声明
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行 node:test 全部测试（引擎/存储/API，共 16 项）
npm start          # 构建并启动 HTTP API（自动选择空闲端口）
npm run demo       # 构建并运行内置演示（平分拉锯、抢七 8:6、冠军点撤销重开）
```

也可直接运行编译产物：

```powershell
node dist/cli.js serve                 # 自动空闲端口
node dist/cli.js serve --port 8080     # 指定端口
node dist/cli.js serve --db data/x.db  # 指定数据库
```

## CLI 命令

```text
tennis serve [--port 端口] [--db 路径]     启动 HTTP API（默认自动选空闲端口）
tennis create <选手0> <选手1> [id]         创建比赛（id 可省略，自动生成）
tennis point <比赛id> <0|1> <请求标识>      登记一分，0/1 分别表示选手0/选手1获胜
tennis state <比赛id>                      查询当前局、盘、整场比分
tennis undo <比赛id>                       撤销最近一分（跨边界安全）
tennis history <比赛id>                    查看逐分过程与含撤销的审计记录
tennis export <比赛id> [文件.json]         导出完整记录（不给文件名则直接打印 JSON）
tennis list                                列出全部比赛
tennis demo                                内置演示
```

CLI 示例：

```powershell
node dist/cli.js create 赵云 雷公 m1
node dist/cli.js point m1 0 req-001     # 赵云得分，15:0
node dist/cli.js point m1 0 req-001     # 同请求标识：幂等返回，不重复加分
node dist/cli.js point m1 1 req-001     # 同标识不同胜方：REQUEST_CONFLICT 错误
node dist/cli.js state m1
node dist/cli.js undo m1
node dist/cli.js history m1
node dist/cli.js export m1 data/m1.json
```

比分输出示例：

```text
第1盘 7:6（抢七 8:6） ✓
第2盘 4:6 ✓
第3盘 5:0
当前局 40:0
```

## HTTP API

服务仅监听 `127.0.0.1`。请求/响应均为 JSON（`Content-Type: application/json`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/matches` | 创建比赛：`{"player0":"甲","player1":"乙","id":"可选"}` |
| GET | `/matches` | 比赛列表 |
| POST | `/matches/{id}/points` | 登记一分：`{"winner":0, "requestId":"唯一标识"}` |
| POST | `/matches/{id}/undo` | 撤销最近一分 |
| GET | `/matches/{id}/state` | 查询比分状态（含中文文本 `text`） |
| GET | `/matches/{id}/history` | 逐分事件 + 审计日志 + 当前状态 |

PowerShell 调用示例：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8080/matches `
  -ContentType 'application/json' `
  -Body (@{player0='林岚'; player1='陈野'; id='m1'} | ConvertTo-Json)

Invoke-RestMethod -Method Post http://127.0.0.1:8080/matches/m1/points `
  -ContentType 'application/json' `
  -Body (@{winner=0; requestId='p-1001'} | ConvertTo-Json)
```

### 错误码

响应体统一为 `{"error":{"code":"...","message":"..."}}`。

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 参数缺失/类型错误、选手同名、名称超长、JSON 非法 |
| 404 | `MATCH_NOT_FOUND` / `NOT_FOUND` | 比赛不存在 / 路由不存在 |
| 409 | `MATCH_FINISHED` | 比赛已结束仍尝试记分 |
| 409 | `REQUEST_CONFLICT` | 同一 requestId 提交了不同获胜方 |
| 409 | `EMPTY_HISTORY` | 无任何得分时撤销 |
| 409 | `MATCH_ID_CONFLICT` | 创建比赛时 id 已存在 |

幂等重复请求（同 requestId、同 winner）返回 `200` 且 `idempotentReplay: true`，首次记分返回 `201`。

## 数据存储

SQLite 文件默认 `data/tennis.db`（另有 `-wal`、`-shm` 运行时文件）。表结构：

- `matches`：比赛 id、两名选手、当前状态快照（JSON）。
- `points`：逐分事件（序号、获胜方、请求标识、时间），`(match_id, request_id)` 唯一。
- `audit_log`：创建、记分、撤销的完整审计记录。

重启服务后直接读取状态快照；状态与 `points` 重放结果的一致性由测试覆盖（见“重启后重放”测试）。导出接口可将选手、全部事件、审计与当前状态保存为 JSON。

## 测试覆盖

`npm test` 覆盖：

- 普通局 0/15/30/40、平分后占先、占先丢失、净胜两分赢局；
- 6:5 继续、7:5 赢盘、6:4 赢盘、6:6 进抢七；
- 抢七 7:6 继续、8:6 结束、抢七后下盘恢复普通局；
- 赢两盘结束并拒绝继续记分；
- 事件重放与逐次推进一致；撤销跨赢局/赢盘/整场边界恢复；
- requestId 重复幂等、冲突报错、连续撤销、空历史撤销、重启后重放一致；
- HTTP API 端到端与参数校验、404。

## 合理假设

- 选手以位置（0 / 1）标识，不模拟发球轮换；抢七的站位/接发次序同样不跟踪。
- 时钟取服务器本地 UTC 时间，仅作记录展示，不影响比分逻辑。
- 服务绑定回环地址 `127.0.0.1`，仅供本机使用。
- `node:sqlite` 在当前 Node 版本会打印一条 ExperimentalWarning，不影响功能。
