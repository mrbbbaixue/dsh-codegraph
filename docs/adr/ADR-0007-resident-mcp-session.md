# ADR-0007：常驻 MCP 会话（查询不再 spawn，索引交给 watcher）

- 状态：已接受
- 日期：2026-09-16
- 覆盖：[ADR-0001](ADR-0001-cli-over-mcp.md) 的接入形态与 [ADR-0005](ADR-0005-index-lifecycle.md) 的自动 `sync` 决策

## 背景

用户要求：把官方那套**常驻 daemon + 文件 watcher** 做出来，于是「不需要每次启动，也不需要每次查询前
sync」。

原来的 CLI 路线（ADR-0001）有两个已知代价，都被记在案：

- 每次调用付 300–500 ms 冷启动；
- **没有 watcher**，所以要在查询前补一次 `sync`（ADR-0005，实测 400–535 ms）。

两者相加，每次 `explore` 有近一秒花在「把环境准备好」上，而这恰好是 codegraph 想替模型省掉的那部分。

## 关键事实（读官方源码得到，不是推测）

`src/mcp/` 的 daemon / proxy 架构决定了能怎么做：

1. **没有「启动 daemon」的 CLI 入口。** `codegraph daemon` 只是个交互式 picker，用来列出来停掉。
   唯一能拉起 daemon 的路径是以普通方式 `serve --mcp`：启动器发现没有 daemon 就 detached spawn 一个。
2. **watcher 挂在 daemon 的 engine 上**，一个 engine 一份。daemon 启动即后台 `ensureInitialized()`，随后
   `startWatching()` + `catchUpSync()`，debounce 默认 2000 ms（待同步 ≤2 个文件时走 300 ms 快速窗口）。
   **daemon 即使 0 客户端也在同步**——但只要有 1 个客户端，idle 计时就是解除状态，不会退出。
3. **proxy 不需要 keepalive。** 它用静态常量本地应答 `initialize` / `tools/list`，只要 stdin 不关、父进程
   活着就一直运行；15 分钟的启动握手兜底在收到**任意一个字节**后永久解除。
4. **CLI 读命令不碰 writer lock。** `writer.pid` 只被 daemon / direct / proxy-fallback 三种写入者争用；
   `codegraph explore` 这类命令直接 `CodeGraph.open()`，与常驻 daemon 并存没有冲突。
5. **协议是换行分隔的 JSON-RPC 2.0 over stdio**，`tools/call` 的 `params` 是 `{ name, arguments }`，
   `result` 就是 `{ content: [...], isError? }`。
6. CLI 的 `sync` 在 daemon 正在同步时拿不到 `codegraph.lock`，**静默返回零结果**——所以它不能当可靠的刷新
   手段。

## 决策

**1. 每个项目一条常驻 MCP 会话。** 插件 spawn 一个长期存活的
`codegraph serve --mcp -p <project>`（`lib/session.js`），说最少的握手，此后所有 `explore` / `node` /
`query` / `callers` / `callees` / `impact` / `files` / `status` 都走这一条连接。会话按**项目根**（
`findIndexRoot`）作键，所以子目录共享同一条，不会给一个项目开出一堆 proxy。

**2. CLI 只留给两类调用。** 写索引的动作（`init` / `index`）和 MCP 面没有对应物的命令（`affected`）。
它们本来就不受 writer lock 影响，并存没有代价。

**3. 显式清掉 `CODEGRAPH_NO_DAEMON`。** 这个环境变量一旦为真，watcher 会搬进我们的子进程，进而去和用户
自己的 Claude Code / Cursor 会话争 `writer.pid`，第二个进程直接 `exit(1)`。插件在这条路径上**必须**让
daemon 模式生效，所以 spawn 时把它作为 tombstone 传下去（`undefined`）。

**4. 自动 `sync` 降级为 CLI 回退路径的新鲜度补偿。** 走常驻会话的查询不再 `sync`——watcher 已经做了。
`autoSync` 开关保留，语义收窄为「CLI 路径上查询前先 sync」。

**5. B1 换成官方 `SERVER_INSTRUCTIONS` 全文。** 用户要求「全部抄过来」。MCP 的 `instructions` 字段 dsh
不收，所以这份 playbook 只能由插件自己注入；既然要抄，就抄全（约 4.5 KB / 约 1600 tokens）。五处必改的
句子（在 dsh 里会变成假话）记在 `lib/guide.js` 的文件头与 README。

**6. 会话进程有三道回收闸，一道都不依赖人记得清理。**

- **项目空闲回收**：`sessionIdleSec`（新设置，默认 900 秒）内没有查询就停掉该会话，下次查询重建。
- **数量上限**：同时活跃的项目会话不超过 8 个；到顶时淘汰最久没被使用的空闲会话。
- **插件卸载**：`ctx.effect` 的 disposer 停掉全部会话。

空闲判定同时做成**懒检查**（每次调用前就地清一遍，所以「换项目」立刻生效）与 **30 秒定时兜底**（`unref`
过，不拖住宿主进程）——只做前者会漏掉「再也不会有下一次调用」的会话，只做后者会让 30 秒内的项目切换先
撞上限。

正在跑调用的会话（`inFlight > 0`）**永远不被动**：空闲回收与上限淘汰都跳过它。所以上限在极端情况下会被
短暂超过，这是有意的——宁可多留一个进程，也不掐断一次活着的调用。

**共享 daemon 不由插件杀。** 它可能正在服务用户自己的 Claude Code / Cursor，杀掉会破坏别人的会话；它自己
在最后一个客户端离开后 30 秒扫描 + 300 秒 idle 超时内退出。插件崩溃或被 SIGKILL 时同样收敛：proxy 子进程
有 PPID 看门狗（5 秒轮询）会自己退出，daemon 随后按同一规则回收。

## 理由

**为什么值得推翻 ADR-0001。** 当年拒绝 MCP 的三条理由，在这个形态下全部失效或反转：

| ADR-0001 的理由 | 现在 |
|---|---|
| `initialize.instructions` 被 dsh 客户端丢弃 | 不再依赖它——插件自己注入 B1，而且**能到 subagent**，比官方的通道还宽 |
| 只暴露 1 个工具、没有自举 | 无所谓——工具是插件自己注册的，自举仍由 `codegraph_index` + `autoIndex` 提供 |
| `serve --mcp` 会拉常驻进程 | **正是这次要的东西**：常驻 watcher 替代了每次查询的 sync |

**为什么不让插件自己实现 watcher。** 官方的监听逻辑不对外复用（ADR-0001 的备选方案已记录），自己写要处理
跨平台事件、debounce、崩溃恢复、inotify 配额，而官方那份已经和索引写入、degrade 上报、staleness banner
耦合在一起。走 `serve --mcp` 是白拿。

**为什么不让子进程自己当 daemon（`CODEGRAPH_NO_DAEMON=1`）。** 那样 watcher 归我们，但 `writer.pid` 会与
用户其它 agent 会话互斥——第二个进来的进程 `exit(1)`。共享 daemon 是官方设计，跟着走。

**为什么自己写 MCP 客户端而不复用 `@deepseek-ai/dsh-mcp-client`。** 复用会把 8 个 `mcp__codegraph__*` 工具
注册进模型可见的工具面，与本插件的 `core`/`full` 面重复；而且我们需要自己控制握手时机、按项目建会话、以及
失败时的回退。

## 后果

**正面**：

- 查询不再付 300–500 ms 冷启动；实测第二次查询起复用同一条连接（测试 `a second query reuses the session`）。
- 索引由 watcher 维护，查询前不再 sync。集成测试里「新增符号下一次查询可见」在**没有 sync** 的情况下通过。
- staleness banner、worktree 错配提示、连接时补齐这些官方特性一并到手。
- B1 与官方 `SERVER_INSTRUCTIONS` 对齐后，模型侧的行为指引不再是插件裁剪过的简版。
- **进程数量有界且不看运气**：项目会话有 `sessionIdleSec` 过期与 8 个上限，插件卸载时全清；唯一的进程泄漏
  路径（插件崩溃 / 被 SIGKILL）由 proxy 的 PPID 看门狗和 daemon 自己的 idle 超时收敛。

**负面**（全部记在 README「已知限制」）：

- 插件会拉起一个**共享的 detached daemon**（约 30 MB），它在插件退出后仍活几分钟。Windows 上它持有项目
  目录里的索引文件，**daemon 活着时那个目录删不掉**——测试必须按 pid 停掉它才能清理 fixture。
- **daemon 与 proxy 版本必须完全相等**；codegraph 升级后旧 daemon 会让新会话降级到进程内只读模式（查询
  可用，自动同步失效）。升级后要手动停旧 daemon。
- watcher 会永久 degrade（WSL2 的 `/mnt`、inotify 配额、`CODEGRAPH_NO_WATCH`），此后索引静默停更，模型只能
  靠 banner 察觉。
- 多了一个约 200 行的协议客户端（`lib/session.js`）要维护：帧解析、id 关联、取消、子进程死亡后的重建。
- B1 从约 1.5 KB 涨到约 4.5 KB，**每请求、每个 subagent 都付**。

## 备选方案

- **保留 CLI，只加一个后台 watcher 进程跑 `sync`**：能省掉查询前的 sync，但省不掉每次 spawn，且要自己实现
  监听与去抖。
- **复用 `@deepseek-ai/dsh-mcp-client`**：工具面重复（见上），且失去按项目建会话的控制。
- **直连 daemon 的 socket**（跳过 proxy 进程）：省一个约 30 MB 的 proxy，但要自己实现 hello 握手、
  `{codegraph_client:1,pid,hostPid}` 保活、以及 socket 路径的平台差异（Windows 命名管道、tmpdir 回落）。
  收益不足以抵消复杂度。
- **什么都不做，继续每次 sync**：就是本次要解决的问题。
