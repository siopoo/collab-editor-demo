# 协同编辑器 Demo

一个基于 DOM 渲染的小型协同编辑器。它刻意不实现完整的 Google Docs：重点是用尽量少的组件清楚展示服务端权威状态、事务 ACK、乐观并发控制、断线重连、有限重试与事务去重。

## 1. 项目怎么运行

要求：Python 3.9+、Node.js 20+。

### Backend

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements-dev.txt
python -m uvicorn app.main:app --reload --port 8000
```

健康检查：`http://localhost:8000/health`。

### Frontend

另开一个终端：

```bash
cd frontend
npm install
npm run dev
```

打开 `http://localhost:5173/?doc=demo`。在两个浏览器窗口中打开相同 URL，即可共享 `demo` 文档。查询参数 `doc` 是文档 ID，例如 `?doc=interview` 会进入另一份内存文档。

### 验证命令

```bash
cd backend
python -m pytest -q

cd ../frontend
npm test
npm run build
```

项目还包含 `scripts/e2e_smoke.py`，用于启动前后端后以两个无头 Chromium 页面验证双向同步、在线人数、ACK 和删除。它是开发验证脚本，需要运行环境已安装 Python Playwright 及 Chromium，不是应用运行依赖。

## 2. 使用了什么技术

- **React**：用组件表达 Block 列表，并直接以 `contentEditable` DOM 节点承载输入；没有引入 Monaco、Quill、Slate、TipTap 等编辑器框架。
- **TypeScript**：把客户端 operation、ACK、conflict、snapshot 定义成可判别联合类型，减少协议分支写错的机会。
- **Vite**：开发服务和生产构建配置很小，适合面试 Demo。
- **FastAPI**：提供轻量 HTTP 健康检查和原生 WebSocket 路由。
- **WebSocket**：一个长连接同时承载 snapshot、operation、ACK、conflict 与 presence，满足低延迟双向通信。

服务端状态只保存在单进程内存中。这不是生产持久化方案，但让本 Demo 的并发控制与协议逻辑保持可读。

## 3. 数据结构怎么设计

```text
Document
└── Blocks[]
    └── { id: string, text: string, version: number }
```

`DocumentStore` 按 `document_id` 保存有序 Block 数组和已处理事务表：

```text
documents[document_id]
├── blocks[]
└── processed_transactions[tx_id] -> previous ACK / conflict
```

选择 Block 而不是一个完整字符串有三个原因：

1. 更新和冲突可以限制在一个 Block 内；不同 Block 的编辑不会争用同一个全局版本。
2. 创建、删除、渲染和未来的段落级能力都有清晰边界。
3. 协议只需传输变化的 Block，不必每次替换整篇文档。

Block ID 必须稳定。React 用它作为 key，服务端用它定位实体，operation 用它在重连和重试后继续指向同一 Block。数组 index 会随插入或删除变化，因此不能作为身份标识。客户端使用 `crypto.randomUUID()` 生成 ID；`version` 由服务端控制，创建后从 1 开始，每次成功更新加 1。

## 4. 协同怎么实现

```text
Browser A ─┐
           │
           ├── WebSocket ── FastAPI ── Document State
           │                     │
Browser B ─┘                     ├── Version Check
                                 ├── Tx Dedup
                                 └── Broadcast
```

完整数据流：

```text
DOM input
  -> optimistic local Block
  -> operation(tx_id, client_id, block_id, base_version)
  -> authoritative server validation
  -> ACK to sender
  -> accepted operation broadcast to other clients
```

### Transaction 与 ACK

每次 create、update、delete 都生成唯一 `tx_id`。服务端处理完成后把响应保存在当前文档的 `processed_transactions` 中。相同 `tx_id` 再次到达时直接返回第一次的响应，不再次修改数据，也不再次广播。因此 ACK 丢失后客户端可以安全重试。

### Version 与 Conflict

update 和 delete 携带 `base_version`。只有它与服务端当前 Block version 完全相等时才接受操作；成功 update 后版本加 1。版本不匹配时服务端不做合并，而是返回最新 Block：

```json
{
  "type": "conflict",
  "tx_id": "...",
  "block": { "id": "...", "text": "server text", "version": 3 }
}
```

客户端以服务端 Block 覆盖本地内容，并显示“内容发生并发修改，已同步服务器最新版本。”。这是有意选择的简单 optimistic concurrency control。

本 Demo 没有选择 OT / CRDT，因为题目重点是把小型协同系统的状态所有权、版本检查、ACK、重试和去重讲清楚。引入框架会显著扩大代码和解释面，也会掩盖这些基本机制。局限是：同一 Block 的并发编辑不能自动合并，后提交的一方可能丢失本地草稿；它也没有操作变换、因果顺序或离线多版本合并能力。

### Reconnect、Retry 与 Deduplication

连接关闭后客户端等待 1.2 秒重连。新连接首先接收权威 snapshot；未 ACK 的 operation 再覆盖到本地视图，并以原 `tx_id` 重发。服务端 tx 去重保证已经执行但 ACK 丢失的事务不会执行两次。

为避免永久坏连接导致无限发送，每个 operation 在一个页面生命周期内最多发送 3 次。超过上限后客户端丢弃该 pending operation，采用下一次服务器 snapshot，并在调试信息面板显示“已达到重试上限”。输入以 300ms debounce 合并；同一 Block 同时只允许一个 update 在途，ACK 后若还有更新的草稿，再用新版本发送下一笔事务。

### 在线人数

服务端按 `document_id` 维护当前 WebSocket 列表。连接或断开时向该文档所有客户端广播连接数量。这里没有实现用户身份、光标或选区 Presence。

## 5. 遇到了什么问题

以下是开发和验证时实际出现的问题：

1. 当前验证环境使用 Python 3.9，`int | None` 注解在模块导入时被求值并触发 `TypeError`。通过 `from __future__ import annotations` 延迟注解求值，保留了类型可读性与 Python 3.9 兼容性。
2. 第一次前端构建中，`tsconfig.node.json` 开启了 `allowImportingTsExtensions`，却没有启用该选项要求的 `noEmit` / `emitDeclarationOnly`，TypeScript 拒绝构建。项目没有带 `.ts` 后缀的 import，因此删除了这个多余选项。
3. 慢网下用户可能在 create ACK 返回前开始输入。若直接用 ACK Block 替换本地 Block，会清空更新的草稿。现在 ACK 只提升服务端 version，保留较新的 DOM 文本；create ACK 后再串行发送草稿更新，并有对应 reducer 回归测试。
4. 仅依赖 tx 去重仍可能让客户端在每次重连时永久重发同一事务。客户端因此增加每事务 3 次的发送上限；服务端去重负责“不会重复执行”，客户端上限负责“不会无限发送”。

## 6. 还有哪些没有完成

- OT / CRDT
- User Cursor 与选区 Presence
- 完整 Undo / Redo
- 持久化 Document Version
- 持久化或周期性 Document Snapshot（已实现连接时的内存 snapshot）
- 多实例同步
- 数据库持久化、鉴权、权限控制和生产级监控

## 7. 如果继续开发，准备怎么优化

以下均为 **Future Work**，当前 Demo 未实现：

1. 引入 operation log 与数据库持久化，定期生成 Document Snapshot，加快恢复速度。
2. 根据产品编辑语义评估 OT 或 CRDT，支持同一 Block 的字符级并发合并与离线编辑。
3. 用 Redis Pub/Sub 连接多个 FastAPI 实例，并把幂等记录放到有过期策略的共享存储。
4. 增加 user presence、光标、选区、身份和权限。
5. 为协议增加 schema version、结构化错误码、日志、指标和追踪。
6. 增加 operation log 驱动的 Undo / Redo，以及文档级恢复点。

## 8. 测试覆盖

后端测试覆盖：

- 创建 Block
- 更新 Block
- 删除 Block
- version 正常增长
- version conflict 返回服务端最新 Block 且不修改状态
- 重复 `tx_id` 返回原响应且不重复执行
- 两个 WebSocket 客户端的 snapshot、presence、ACK 与广播

前端测试覆盖 snapshot、按稳定 ID 应用远端更新、冲突覆盖、重连时 pending overlay、create ACK 保留新草稿和有限重试边界。生产构建通过 `tsc -b && vite build`。浏览器 smoke test 实际打开两个页面验证了 A→B、B→A、在线人数、ACK 与删除同步。

## 9. Demo 演示步骤

1. 启动 backend 和 frontend，在两个窗口打开 `http://localhost:5173/?doc=demo`。
2. 确认两个窗口都显示“已连接”和“在线人数：2”。
3. 在 A 点击 **新建第一个文本块**，输入文本；约 300ms 后 B 显示相同内容。
4. 在 B 修改同一 Block；A 实时收到新文本和递增后的 version。
5. 观察底部“最近一次 ACK”与“待确认操作”；正常完成后显示“当前没有待确认操作”。
6. 在 B 删除 Block；A 同步移除。
7. 停掉 backend，观察连接状态变为“正在重连”；重新启动 backend 后客户端自动连接并请求 snapshot。
8. 重复 tx 去重可运行 `python -m pytest tests/test_document_store.py -k duplicate -vv` 演示：同一 `tx_id` 调用两次，但文档只有一个 Block。
9. version conflict 可运行 `python -m pytest tests/test_document_store.py -k stale -vv` 演示：两个操作都基于 version 1，只有第一个成功，第二个收到 version 2 的最新 Block。

注意：服务端重启会清空所有文档，因为当前状态仅在内存中。要演示“ACK 丢失后的重连重试”而不丢服务端状态，应只断开浏览器网络/WebSocket，不要重启服务端进程。

## 设计取舍与关键问题

### 服务端作为权威状态

所有客户端提交都经过同一个版本检查和顺序化入口，ACK 和广播只描述已经接受的状态。否则两个客户端可能各自认为自己的写入成功，无法给出一致结果。

### Block 级版本控制

Block version 缩小冲突域：编辑不同 Block 可以同时成功。代价是跨 Block 的原子事务和文档级一致版本尚未实现。

### 事务去重与版本校验

tx_id 解决“同一操作因重试到达多次”；version 解决“不同操作基于同一旧状态并发修改”。两者不能互相替代。

### 当前冲突策略及局限

没有 OT / CRDT 时，字符级合并很容易产生不可预测结果。当前策略选择确定性：拒绝旧版本、展示服务端最新值、明确告知用户。它适合解释机制，不适合无损多人写作。

### 断线期间的操作处理

操作进入 `pending`，重连 snapshot 到达后以同一 `tx_id` 有限重试。若服务端已经执行，去重表返回原 ACK；若未执行，则正常执行；超过 3 次仍无 ACK 就停止发送并采用权威 snapshot。

### 多实例扩展思路

内存文档和连接表必须拆分：数据库保存 snapshot / operation log，共享幂等存储保存 tx 结果，Redis Pub/Sub 或等价消息层把一个实例接受的 operation 广播到其他实例上的 WebSocket 客户端。
