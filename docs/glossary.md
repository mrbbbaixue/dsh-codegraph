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
| **staleness banner** | `explore` 输出里 `⚠ Changed on disk after the last index sync: <file>` | **只覆盖已索引文件的内容漂移**，覆盖不了"新符号静默不可见"（见 ADR-0005） |
| **MCP 面** | `codegraph serve --mcp` 暴露的工具集合。默认只有 `codegraph_explore`（`DEFAULT_MCP_TOOLS`），可用 `CODEGRAPH_MCP_TOOLS` 加回 | 本项目**不用** MCP，但沿用了它"只给 explore"的结论 |
| **daemon** | `serve --mcp` 在能解析到 `.codegraph/` 时 connect-or-spawn 的 detached 进程；`.codegraph/` 下留 `daemon.sock`/`.pid`/`.log` | CLI 单次调用**不会**拉起它（实测：调用前后进程数不变） |
| **watcher** | 文件监听，写入后约 1 s 自动同步。**只有 `serve --mcp` 会起** | 这是 CLI 路线的主要代价，由 `autoSync` 补偿 |
| **`prompt-hook`** | hidden 命令。stdin `{prompt, cwd}` → stdout `<codegraph_context>` 块。失败静默 exit 0，上限 9000 字符，三级门控 | 官方定位 Claude Code 专有；B2 复用它，靠熔断限制风险 |
| **`SERVER_INSTRUCTIONS`** | 官方给 agent 的 4.5 KB playbook，通过 MCP `initialize.instructions` 下发 | dsh 的 MCP 客户端**把它整个丢弃了**——这是本项目的立项理由 |
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
| **B1** | 静态提示词注入：`ctx.systemPrompt.section`，每请求固定约 1.5 KB |
| **B2** | 动态前置注入：`agent/pre-step` 里跑 `codegraph prompt-hook`，把 explore 结果塞进当步 |
| **core 面 / full 面** | `core` = `explore` + `index`；`full` 在其上追加其余 8 个工具 |
| **解析链** | runner 找 codegraph 的顺序：插件内依赖 → `~/.codegraph/bundles` 缓存 → PATH |
| **熔断** | B2 的 `prompt-hook` 连续失败 2 次后，本进程内不再尝试（不落盘、不阻塞启动） |
