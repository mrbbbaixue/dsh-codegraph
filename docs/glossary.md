# 术语表

本表只收"容易混淆、且混淆会导致实现出错"的词。每条以**在本项目里实际指什么**为准，不是通用定义。

## codegraph 侧

| 术语 | 在本项目里指什么 | 易混淆点 |
|---|---|---|
| **codegraph（CLI）** | `codegraph` 可执行命令。本项目**唯一**实际调用的东西，通过子进程 spawn | 不要与下面的"包"混为一谈 |
| **thin 包** | npm 上的 `@colbymchenry/codegraph`，0.7 MB，只有 `npm-shim.js` + `npm-sdk.js` + `.d.ts` | 它**不含**运行时 |
| **平台包** | `@colbymchenry/codegraph-<platform>-<arch>`，261–293 MB，含**自带 Node 24** + 完整 dist + wasm 语法。是 thin 包的 optionalDependency | 它才是真正的运行时 |
| **shim** | `npm-shim.js`。解析平台包 → 找不到就从 GitHub Releases 下载到 `~/.codegraph/bundles/` | 本项目统一经它执行，不自实现自愈 |
| **SDK** | `npm-sdk.js` / `lib/dist/index.js`，`CodeGraph` 类。**本项目不用**（见 ADR-0001） | 它在本进程内跑，会阻塞事件循环 |
| **索引** | 项目根下的 `.codegraph/codegraph.db`（SQLite + FTS5 + WAL） | 按**项目根**存，不是全局，也不是按 cwd |
| **`explore`** | 主力查询命令。返回相关符号的逐字源码（按文件分组、带行号）+ 调用路径 + 波及面 | 输出是给 LLM 的 markdown，**没有 `--json`** |
| **`node`** | 单符号（源码 + caller/callee trail）或整文件（行号 + dependents） | 与内置 `read` 功能重叠，因此不在默认面 |
| **`init` / `sync` / `index`** | `init`=首次建索引；`sync`=增量；`index`=全量重建。本项目合成一个 `codegraph_index` 工具的三个 operation | 别把 `index`（全量）和 `sync`（增量）当同义词 |
| **staleness 提示** | 四类，全是 codegraph 服务端发出的：① `⚠️ Some files referenced below were edited since the last index sync`（待同步文件被这份响应提到）② `(Note: … pending index sync …)`（待同步但没被提到）③ `⚠ changed on disk after the last index sync`（发结果时 stat+hash 发现漂移；小文件整份给当前字节，大文件省略源码）④ `⚠️ CodeGraph auto-sync is DISABLED`（watcher 已**永久 degrade**） | ①②④ **需要 watcher**，③不需要。**`CODEGRAPH_NO_WATCH` 与 WSL2 `/mnt` 走 `watchDisabledReason`，不置 degraded、没有任何 banner**（只写 stderr） |
| **MCP 面** | `codegraph serve --mcp` 暴露的工具集合。默认只**列** `codegraph_explore`，其余 7 个定义着但不列（`CODEGRAPH_MCP_TOOLS` 可开）；本项目 8 个都调，但不列给模型 | 本项目**自己实现 MCP 客户端**（`lib/session.js`），不用 `@deepseek-ai/dsh-mcp-client`（见 ADR-0007） |
| **daemon** | `serve --mcp` 在能解析到 `.codegraph/` 时 connect-or-spawn 的 detached 进程；`.codegraph/` 下留 `daemon.sock`/`.pid`/`.log`。**watcher 与唯一的 SQLite writer 都在它里面** | 没有「启动 daemon」的 CLI 入口——`codegraph daemon` 只能列出并停掉。插件**不杀**它（可能正在服务别人的 Claude Code） |
| **watcher** | 挂在 daemon 的 engine 上的文件监听，写入后约 1–2 s（待同步 ≤2 个文件时 300 ms）自动增量同步 | 只存在于 `serve --mcp` 这条路；CLI 单次调用没有它，所以 CLI 回退路径用 `autoSync` 补偿 |
| **`prompt-hook`** | hidden 命令。stdin `{prompt, cwd}` → stdout `<codegraph_context>` 块。失败静默 exit 0，上限 9000 字符，三级门控 | 官方定位 Claude Code 专有；B2 复用它，靠熔断限制风险 |
| **`SERVER_INSTRUCTIONS`** | 官方给 agent 的 4.5 KB playbook，通过 MCP `initialize.instructions` 下发。**本项目把它整段**做成 B1（只改五处在 dsh 里会变成假话的句子） | dsh 的 MCP 客户端把 `instructions` 整个丢弃，所以这段文本只能由插件自己注入——而插件注入的还能到 subagent |
| **`CODEGRAPH_INSTRUCTIONS_BLOCK`** | installer 写进 `CLAUDE.md`/`AGENTS.md` 的 ~0.9 KB marker 块 | 它存在的原因是 subagent 拿不到 MCP instructions |

## dsh 侧

| 术语 | 在本项目里指什么 | 易混淆点 |
|---|---|---|
| **profile** | `~/.dsh/profiles/<name>`，一个 pnpm 项目。本项目装进 `web` profile | — |
| **bundle** | 声明了 `dsh.bundle.patch` 的 npm 包；安装时被追加进 `dsh.profile.bundles` 层栈 | 不是 webpack 的 bundle |
| **`cordis.patch.yml`** | bundle 的 patch 层。本项目只有一行 `- insert: [{ id, name }]` | 用户自己的同文件在 bundle 层**之后**应用，可覆盖 |
| **namespace plugin** | 插件的导出形状：具名导出 `name` / `inject` / `apply` / `Config`，**无 default** | 与 `dsh-context` 等一致 |
| **settings namespace** | `ctx.settings.register(NS, Schema)` 注册的配置命名空间，值落 `~/.dsh/settings.yaml` 的 `NS:` 下 | **host 与浏览器半边的 join key** |
| **`settings.plugin.item`** | 设置页「插件配置」标签页的嵌套 slot，以 settings namespace 为 key | host 注册了 namespace 但没注册卡片 → **什么都不渲染** |
| **`PromptSection`** | `ctx.systemPrompt.section()` 的输入，进**系统提示词文本** | 与下面的 Context 是两回事 |
| **`PromptContext`** | `ctx.systemPrompt.context()` 的输入，成为模型历史里带来源的 user 快照 | **同步 provider**，且 `AssembleContext` 里没有 agent/prompt——B2 用不了它 |
| **`getSectionOrder(name)`** | 解析第一方 section 的 alloc 位置（`TOOL_BASH:1000` / `TOOL_READ:1100` / `TOOL_GREP:1500` …） | 别硬编码这些数字，会上游漂移 |
| **`agent/pre-step`** | 步骤进入前的 waterfall，可拒绝该步或替换进入它的消息。B2 用它 | 每步都触发，要自己判断"这步是否带新的用户消息" |
| **`agent.inject()`** | "给下一个被接纳的步骤加模型可见上下文，**不唤醒驱动器**" | B2 用的是它的**位置语义**，但通过 pre-step 改写实现时机确定性 |
| **`agent.steer()`** | 提交 steering，**会唤醒**空闲驱动器 | jiangzhenguo 用它做前置注入，语义过重 |
| **`tools/pre-execute` / `ask`** | 可扩展的允许/拒绝/询问门禁。返回 `ask` 会走 `ctx.approval` 一次性确认；**缺审批服务时按拒绝处理** | `init`/`index` 的门禁挂在这里 |
| **subprocess seam** | `ctx.subprocess`，`resolveExecutable()` + `spawn({ argv, cwd, stdio, graceMs, signal })` | **没有 `timeoutMs` 字段**，只有 `signal`；超时要靠 `defineTool.timeoutMs` |
| **client 半边** | `lib/client.js`，`window.__ModuleLoader__.load({ id, factory })` 格式的 lazy-CJS factory | 可用 `React.createElement` 手写，不必上构建工具 |
| **deferred tool** | MCP 的"列出但不加载"机制 | **dsh 没有这层**：不给 schema 就是彻底不可用 |

## 本项目自有

| 术语 | 含义 |
|---|---|
| **B1** | 静态提示词注入：`ctx.systemPrompt.section`，官方 `SERVER_INSTRUCTIONS` **全文**，每请求固定约 4.5 KB |
| **B2** | 动态前置注入：`agent/pre-step` 里跑 `codegraph prompt-hook`，把 explore 结果塞进当步 |
| **core 面 / full 面** | `core` = `explore` + `index`；`full` 在其上追加其余 8 个工具 |
| **解析链** | runner 找 codegraph 的顺序：配置的 `executable` → 插件内依赖的 shim → 磁盘上的自包含安装 → PATH |
| **常驻会话** | 每个项目一条长期存活的 `codegraph serve --mcp` 子进程（`lib/session.js`），查询走它的 `tools/call` |
| **熔断** | B2 的 `prompt-hook` 连续失败 2 次后，本进程内不再尝试（不落盘、不阻塞启动） |
