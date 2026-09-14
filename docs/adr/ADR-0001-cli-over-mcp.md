# ADR-0001：用 CLI 子进程替换 MCP 接入

- 状态：已接受
- 日期：2026-09-14
- 背景：本插件立项的前提

## 背景

dsh 接入 codegraph 的既有方式是 MCP：用 `@deepseek-ai/dsh-mcp-client` 以 stdio 方式拉起 `codegraph serve --mcp`。也就是说 dsh 已经能调 codegraph，写这个插件不是为了"能用"，而是为了替换它。

现状有三个硬缺陷，第一个是决定性的：

1. **提示词进不来。** codegraph 在 MCP `initialize` 响应里返回约 4.5 KB 的 `SERVER_INSTRUCTIONS` playbook（"reach for codegraph BEFORE grep/read" + 四条 anti-pattern + 局限说明）。`@deepseek-ai/dsh-mcp-client` 的实现里 grep `instructions` **零命中**——这个字段被整个丢弃。模型只是"多了一个工具"，没有任何"该优先用它"的引导。
2. **只暴露一个工具。** `DEFAULT_MCP_TOOLS = new Set(['explore'])`，其余 7 个定义着但不列给模型。这一条本身是官方有意的设计（见 ADR-0004），不算缺陷，但它意味着 MCP 面**没有自举能力**——未索引时官方口径是 "indexing is your decision"，不代跑 `init`。
3. **会拉常驻进程。** `serve --mcp` 在能解析到 `.codegraph/` 时 connect-or-spawn 一个 detached daemon，并在 `.codegraph/` 留下 `daemon.sock` / `daemon.pid` / `daemon.log`。

## 决策

插件走 **CLI 子进程**：每次工具调用 spawn 一次 `codegraph`，用完即退。不做 MCP server、不做 HTTP server、不 import SDK，也不注册 `@deepseek-ai/dsh-mcp-client`。

## 理由

三条路都实测过：

| 路线 | 常驻进程 | 冷启动 | 提示词能否到达模型 | 结论 |
|---|---|---|---|---|
| CLI 子进程 | 无 | `explore` 306–493 ms、`status -j` 136 ms、`files -j` 240 ms | 插件自己注入 | **采纳** |
| MCP stdio | 有（detached daemon，除非 `CODEGRAPH_NO_DAEMON=1`） | MCP server 首次可用 2–3 s | 被 dsh 客户端丢弃 | 放弃 |
| SDK in-process | 无 | 同进程 | 插件自己注入 | 放弃 |

CLI 路线的实测证据：调用 `codegraph explore` 前后系统内 node 进程数不变（8 → 8），无残留。而 `explore` 的输出与 MCP 工具 `codegraph_explore` 返回的是**同一个字符串**（源码里 `handler.execute('codegraph_explore', args)` 后直接 `console.log`），本来就是给 LLM 读的 markdown。

放弃 SDK 的三条理由：

- `npm-sdk.js` 自己注释写明：嵌入式宿主若驱动大型索引，**必须给宿主 Node 传 `--liftoff-only`**（否则 tree-sitter WASM 撞 V8 Zone OOM）——dsh 的 node 启动参数我们控制不了。
- 官方 SDK 的 sqlite 查询是**同步**的（`node:sqlite` 的 `DatabaseSync`），官方自己都要用 worker 隔离，直接 import 会卡住 dsh 的事件循环。
- 平台包没有 `exports` 字段，只能按安装目录绝对路径 import 内部文件。

## 后果

**正面**：崩溃隔离；不阻塞 dsh 事件循环；不受宿主 Node 版本限制；不依赖 MCP 客户端在场；无残留进程；可以在插件里实现官方 MCP 面没有的 `index` 自举。

**负面**：

- 每次调用付 300–500 ms 冷启动。
- **失去 watcher**。`serve --mcp` 会起文件监听（写入后 ~1 s 自动同步），CLI 路径没有。这直接导致 ADR-0005 里的自动 `sync` 决策。
- `explore` / `node` 没有 `--json`，输出是装饰文本，不能结构化。

## 备选方案

- **保留 MCP，插件只做提示词注入 + index 工具**：白拿 watcher 和常驻进程的性能，但模型会同时看到 `codegraph_explore` 和 `mcp__codegraph__codegraph_explore` 两个近乎同名的工具，B1 文案还得解释用哪个；且把项目绕回"常驻 daemon"形态，与立项诉求冲突。
- **插件自己起后台 watcher 维持新鲜度**：官方的监听逻辑只能通过 `serve --mcp` 拿到，不开放复用；自己实现要处理文件监听、去抖、崩溃恢复、跨平台策略，性价比极低。

## 修订记录

### 2026-09-16：查询改走常驻 MCP 会话，本文的接入形态被覆盖

**起因**：用户要求把官方那套「常驻 daemon + 文件 watcher」做出来，目标是「不需要每次启动，也不需要每次查询前
sync」。

**改了什么**：查询改走**插件自己实现的 MCP 客户端**（`lib/session.js`，每项目一条常驻
`codegraph serve --mcp` 会话），CLI 只保留写索引的动作（`init` / `index`）与 MCP 面无对应物的命令
（`affected`）。

**为什么当年否决 MCP 的三条理由都不再成立**：`initialize.instructions` 仍然被 dsh 的 MCP 客户端丢弃——但本
插件既然自己写客户端，就不依赖它，B1 反而能覆盖到 subagent；「只暴露 1 个工具、没有自举」与本插件自己注册
工具面无关，`codegraph_index` + `autoIndex` 照旧；「`serve --mcp` 会拉常驻进程」**正是这次要的东西**，它替代了
本文代价里那条「失去 watcher」。

**没变的部分**：不注册 `@deepseek-ai/dsh-mcp-client`；`codegraph` 仍是子进程而非 SDK（同步 sqlite 会卡住 dsh
的事件循环，见本文「理由」）；自举能力仍由本插件提供。完整决策见
[ADR-0007](ADR-0007-resident-mcp-session.md)。
