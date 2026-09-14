# dsh-codegraph 实施计划

包名 `@mrbbbaixue/dsh-codegraph`。给 DeepSeek Harness 提供 codegraph 代码知识图谱能力，**替代** dsh 既有的 MCP 接入方式（`@deepseek-ai/dsh-mcp-client` + `codegraph serve --mcp`）。

决策理由见 [`docs/adr/`](docs/adr/README.md)，术语见 [`docs/glossary.md`](docs/glossary.md)。本文件只讲**怎么做**。

---

## 0. 已定决策一览

| # | 决策 | ADR |
|---|---|---|
| 1 | CLI 子进程，不用 MCP / SDK；不注册 MCP 客户端，也不需要外部 MCP 配置 | [0001](docs/adr/ADR-0001-cli-over-mcp.md) |
| 2 | 声明 `@colbymchenry/codegraph` 为 dependency；runner 解析链 = 插件内依赖 → `~/.codegraph` 缓存 → PATH | [0002](docs/adr/ADR-0002-codegraph-runtime-provisioning.md) |
| 3 | B1 = `systemPrompt.section`；B2 = `agent/pre-step` 改写 + 官方 `prompt-hook` 门控 | [0003](docs/adr/ADR-0003-two-layer-prompt-injection.md) |
| 4 | 工具面 `core` = `explore` + `index`；`full` 追加 8 个 | [0004](docs/adr/ADR-0004-tool-surface-explore-and-index.md) |
| 5 | 查询前自动 `sync`；未索引时自动 `init`（受 `autoIndexMaxFiles` 限制）；工具发起的 `init`/`index` 走 `ask` 审批，`sync` 放行 | [0005](docs/adr/ADR-0005-index-lifecycle.md) |
| 6 | 零构建单包；手写 client bundle；设置面板承载全部 9 个设置（无状态行） | [0006](docs/adr/ADR-0006-plugin-shape-and-settings-card.md) |

---

## 1. 包结构

```
package.json          dsh.bundle.patch + dsh.client + dependencies + peerDependencies
cordis.patch.yml      - insert: [{ id: dsh-codegraph, name: '@mrbbbaixue/dsh-codegraph' }]
lib/
  index.js            入口：Config / apply / 工具注册 / B1 section / B2 pre-step / 审批门禁
  guide.js            B1 提示词文本（独立文件，便于评审与改文案）
  runner.js           进程执行：解析链、Windows shim 分支、超时、输出收集、错误归一
  client.js           浏览器半边：设置面板（手写，React.createElement）
README.md
docs/
  adr/                ADR-0001..0006 + 索引
  glossary.md
PLAN.md               本文件
test/
  run-plugin-test.mjs 自带 fixture 的运行时 harness
```

`package.json` 关键字段：

```json
{
  "name": "@mrbbbaixue/dsh-codegraph",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "README.md", "docs"],
  "dependencies": { "@colbymchenry/codegraph": "^1.6.0" },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": ">=0.1.2-rc.1 <0.2.0",
    "@deepseek-ai/dsh-llm": ">=0.1.2-rc.1 <0.2.0",
    "@deepseek-ai/dsh-system-prompt": ">=0.1.2-rc.1 <0.2.0",
    "@deepseek-ai/dsh-subprocess": ">=0.1.2-rc.1 <0.2.0",
    "@deepseek-ai/schemastery": ">=3.0.0 <4.0.0"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
  }
}
```

---

## 2. 关键实现要点

### 2.1 Config 与默认值

```js
export const name = 'codegraph'
export const inject = ['tools', 'systemPrompt']
export const Config = z.object({
  guide: z.boolean().default(true),
  frontload: z.boolean().default(true),
  surface: z.union([z.const('core'), z.const('full')]).default('core'),
  autoSync: z.boolean().default(true),
  autoIndex: z.boolean().default(true),
  autoIndexMaxFiles: z.natural().min(1).default(10000),
  executable: z.string().default('codegraph'),
  exploreTimeoutSec: z.natural().min(1).default(120),
  indexTimeoutSec: z.natural().min(1).default(900),
})
```

前三个是**设置面板行为段里的开关**，因此实际生效值必须走 `ctx.settings` 解析后的结果，不能只用 `apply(ctx, config)` 的入参（那个是组装默认值）。九个字段全部上卡片，组装层只是这批值的默认来源。

### 2.2 runner

**解析链**（每次调用重读，不在 `apply()` 期探测——`plugin-host.js` 的历史版本在 apply 期解析执行器并在缺失时抛错，注释里记录过它造成的启动期崩溃）：

1. 插件内依赖：`createRequire(import.meta.url).resolve('@colbymchenry/codegraph/npm-shim.js')`
2. `~/.codegraph/bundles/<platform>-<arch>-<version>/`（shim 自愈留下的缓存）——这条由 shim 内部处理，我们只需 fall through 到它
3. PATH 上的 `codegraph`

**统一执行方式**：`spawn(process.execPath, [shimPath, ...args])`。shim 自己负责平台包解析、Windows `.cmd` 规避、自愈下载。它的 `spawnSync(..., { stdio: 'inherit' })` 继承的正是我们在 subprocess seam 里设的管道，所以 stdout/stderr 仍能分别收集——**这条依赖 shim 的实现细节，要加断言**，上游改成管道重定向就得自己接。

**Windows 的坑（已实测，必须处理）**：

```
spawn('codegraph', [...])                 -> ENOENT
spawn('codegraph.cmd', [...])             -> EINVAL   # Node 22 起禁止直接 spawn .cmd
spawn('cmd.exe', ['/c', shim, ...args])   -> exit 0   # 实测四类参数（中文/空格/&/"）全通过
spawn('<install>\\node.exe', [...])        -> exit 0
```

`ctx.subprocess.resolveExecutable('codegraph')` 在 Windows 上按 `PATHEXT` 会返回 `.cmd` 路径，而 `dsh-subprocess-local` 的 `spawn()` 全文件**没有任何** `.cmd`/`cmd.exe`/`shell` 包装——直接用它必然 EINVAL。走 shim 就绕开了这个问题（shim 自己用 `node.exe + entry`）。

**超时**：subprocess seam **没有** `timeoutMs` 字段，只有 `signal`。所以每个工具都必须显式声明 `timeoutMs`（由 `dsh-tool-call-timeout-policy` 读取并换掉 `exec.signal`）。漏声明 = 没有超时。

**输出**：

- exit ≠ 0 时抛错，细节优先取 stderr、为空再取 stdout；两者都空时至少带上 exit code 与命令行。
- `stripAnsi` 用 `util.stripVTControlCharacters`（非 TTY 下 CLI 本来就自动禁用颜色，属保险）。
- **JSON 结果不按字符盲截**：截断后不再是合法 JSON，模型无法分辨"CLI 出错"与"被插件截断"。只在 `explore` 的 markdown 输出上截断，且截断处写明结果不完整。

**工作区**：默认 root = `exec.agent?.session?.header?.cwd`；工具参数 `path` 可覆盖。**不要**用 `cwd || '/'` 兜底；缺 cwd 且无 `path` 时直接抛错。索引探测向上最多 12 层，限制在会话工作区内。

### 2.3 B1

```js
ctx.systemPrompt.section({
  name: 'tool:codegraph',
  order: sectionOrder(),   // getSectionOrder('TOOL_BASH') - 10，取不到时回退常量
  text: CODEGRAPH_GUIDE,
})
```

文案以官方 `SERVER_INSTRUCTIONS` 为底本裁到约 1.5 KB，工具名映射到 `codegraph_explore` / `codegraph_index`，并补上官方没有的自举路径。草稿（英文，与上游文案一致）：

```markdown
# CodeGraph — pre-indexed code knowledge graph

CodeGraph is a pre-computed graph of every symbol and call edge in a project, built by the `codegraph` CLI. When the current workspace is indexed (a `.codegraph/` directory at its root), reach for these tools BEFORE grep/glob/read to locate or understand code:

- `codegraph_explore` — PRIMARY, and Read-equivalent. Give it a natural-language question or a bag of symbol/file names. One capped call returns the verbatim, line-numbered source of the relevant symbols grouped by file — treat that source as already read — plus the call paths among them (including dynamic-dispatch hops grep cannot follow) and a blast-radius summary.
- `codegraph_index` — build or refresh the index (`operation: init | sync | index`). `init` and `index` ask the user first; `sync` is cheap and incremental.

Anti-patterns — do NOT:
- grep/glob first "to find the files": one `codegraph_explore` call replaces dozens of round-trips.
- re-verify codegraph results with grep: they come from a full AST parse.
- reconstruct a flow by hand: name the endpoints in one `codegraph_explore` and it surfaces the path between them.
- keep calling codegraph after it reports the workspace is not indexed and the user declined to index it: use the built-in tools there instead.

Limits: the index is refreshed before every query, but a symbol added outside this session may still be missing until then. Cross-file resolution is best-effort name matching. CodeGraph is not a correctness check — that is still the compiler, tests, and linter.
```

### 2.4 B2

`ctx.on('agent/pre-step')` 里 `await next()`，判断这一步是否携带了新的真实用户消息（`role === 'user'` 且来源是用户，不是本插件自己的注入），命中则：

1. 按 prompt 文本查去重表（每 agent 一个 Map，10 分钟过期，上限 20 条）。
2. spawn `codegraph prompt-hook`，stdin 写 `{ prompt, cwd }`，**硬超时 3 s**。
3. stdout 有 `<codegraph_context>` 块就把消息插进 `decision.messages`（已领取消息之后），来源用 plugin，**不伪造 user**。
4. 任何失败（ENOENT / 非零退出 / 超时 / 空输出）都静默跳过；同进程内连续失败 2 次后熔断，不再尝试。

去重是必须的：GUI 重发/重试会让同一条 prompt 多次进 `nextTurn`，不去重会重复注入十几 KB。

### 2.5 index 审批与自动 init

`ctx.on('tools/pre-execute')` 里判断 `name === 'codegraph_index'` 且 `arguments.operation` 是 `init` 或 `index` → 返回 `ask` 决策（走 `ctx.approval`）。`sync` 与其余工具放行。缺审批服务时按 fail-closed 处理。

`operation: init` 不接受 `--force`；根目录 / 家目录路径直接拒绝。

插件**自己**发起的 `init`（`codegraph_explore` 发现工作区没有索引时）不走这道门：授权是用户在设置里给的
（`autoIndex`，默认开），决定"多大算太大"的旋钮是 `autoIndexMaxFiles`（默认 1 万）。计数只遍历目录树、
跳过点目录与 `node_modules`，超过上限立刻停止遍历。超过上限、`autoIndex` 关掉或 `init` 失败时，改由
`explore` 返回说明文本，让模型走工具 + 审批那条路。

### 2.6 client 卡片

```js
window.__ModuleLoader__.load({
  id: 'dsh-codegraph',
  factory: (require) => {
    var module = { exports: {} }
    let react = require('react')
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // ctx.inject(['settingsScope'], ...) → settings.attach(binder.bind({ namespace: NS }))
    // ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name, key: NS, ... }, Card))
    module.exports = { name: 'dsh-codegraph', inject: ['slots', 'locale'], apply }
    return module.exports
  },
})
```

- `NS` 必须与 host 侧 `ctx.settings.register(NS, Schema)` 的 namespace **完全一致**——它是唯一的 join key。
- 实现前先对照任一已装 `dsh-context` 的 profile：`~/.dsh/profiles/<profile>/node_modules/dsh-context/lib/client.js`（其 9761–9790 行是完整可抄的注册骨架）。
- 面板是设置页其它插件卡片同形的 `<li>`：标题行开合，面板内列出全部 9 个字段；控件改动即写入（`scope.set` / `scope.unset`），没有保存按钮。**不放状态行**（理由见 ADR-0006）。

---

## 3. 实施阶段

下面只是阶段与验收的骨架。**逐文件、逐接口的编写顺序见 [`docs/IMPL-PLAN.md`](docs/IMPL-PLAN.md)**（含实测环境、宿主 API 的 `file:line` 契约、以及本文未覆盖的 8 个坑）。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** 骨架 | `package.json` / `cordis.patch.yml` / 空 `apply` / `README.md`；开发期用 `dsh plugin --profile <name> add <本仓库路径>` 装进任一 profile | `dsh --profile <name> --dump-default-config` 里出现本插件行；启动无报错 |
| **P1** B1 | `lib/guide.js` 文案定稿 + `section()` + `getSectionOrder` | 新会话里模型能复述"优先用 codegraph_explore 而不是 grep"；`guide: false` 后消失；subagent 也生效 |
| **P2** runner + 两个工具 | `lib/runner.js`（解析链、Windows 分支、超时、错误归一）；`explore` / `index`；自动 `sync`；未索引时自动 `init` | Windows 上 `explore` 返回真实源码；未索引的工作区被自动建索引后返回结果；超上限/关掉开关时给出可读说明；取消能杀掉进程；`autoSync: false` 后行为退化但可用 |
| **P3** 审批门禁 | `tools/pre-execute` 的 `ask`；路径白名单 | `init` 弹审批；拒绝后不建索引；`sync` 不弹；插件自动发起的 `init` 不走门禁 |
| **P4** B2 | `agent/pre-step` + `prompt-hook` + 去重 + 熔断 | 结构性 prompt 注入 `<codegraph_context>`；非结构性静默；同文重发不重复；超时 3 s 后放弃不拖 turn |
| **P5** 设置面板 | `lib/client.js` + `dsh.client` + host 侧 `settings.register` | 设置页出现 CodeGraph 面板，9 个字段即改即存、可重置；值落 `~/.dsh/settings.yaml` |
| **P6** full 面 | 其余 8 个工具 | 每个工具一次真实调用 |
| **P7** 收尾 | 补 README：Model Experience、已知限制、**从 MCP 接入迁移的说明**（装了本插件后可有可无地移除既有 `mcp-codegraph` 行） | README 能让新用户独立完成安装、迁移与排障 |

---

## 4. 测试与验收

参照 jiangzhenguo 的运行时 harness 模式，但修掉它的三个问题（用例只断言"没抛错"、fixture `/tmp/cg-test-proj` 在仓库外手工存在、CI 从未真正跑过）：

- **桩 ctx**：只实现 `tools.register` / `tools.get` / `systemPrompt.section` / `systemPrompt.getSectionOrder` / `on` / `get` / `settings.register`。
- **自带 fixture**：测试脚本自己 `mkdtemp` 建 2–3 个源文件的小项目并跑真实 `codegraph init`，断言 `explore` 返回里**包含 fixture 里的符号名**（内容断言）。
- **结构性契约断言**：`core` 面恰好 2 个工具、`full` 面 10 个；B1 section 的 order 小于 `TOOL_READ` 的 order；`guide: false` 不注册 section；`frontload: false` 不注册监听器。
- **Windows 分支单测**：构造 `C:\...\codegraph.cmd` 路径，断言 argv 未被直接交给 `spawn`，而是走了 shim。
- **B2 用例**：结构性中文 prompt 注入；非结构性静默；同文重发不重复；未索引静默；`prompt-hook` 失败时熔断生效。
- **跨平台**：脚本不能依赖 `which` / `/bin/bash`。

端到端验收（人工，一次）：

1. **未索引**的中型仓库 → 问结构性问题 → 模型调 `codegraph_explore` → 插件自动 `init` → 同一次调用里拿到答案。
2. **已索引**仓库 → 问"X 是怎么实现的" → 一次 `explore` 拿到源码与调用链，不退回 grep/read。
3. 改一个源文件后立刻问 → 结果反映新代码。
4. 新增一个符号后立刻问 → 结果**能找到它**（这是 `autoSync` 存在的全部理由）。
5. 把 `autoIndexMaxFiles` 调到 1 → 未索引的仓库不再自动建索引，返回说明让人或模型去 `codegraph_index`。

---

## 5. 风险清单

| # | 风险 | 处理 |
|---|---|---|
| 1 | Windows 上直接 spawn `.cmd` 必然 EINVAL | 统一走 shim（2.2），加单测 |
| 2 | 镜像源跳过平台包，依赖声明拿不到运行时 | 解析链回退 + shim 自愈下载 |
| 3 | subprocess seam 没有 `timeoutMs` | 每个工具显式声明；漏了就等于没超时 |
| 4 | `getSectionOrder` 的名字上游可能变 | try/catch + 常量回退 |
| 5 | 新符号静默不可见 | `autoSync`（默认开） |
| 6 | B2 依赖 hidden 命令 `prompt-hook` | 熔断；失效只影响 B2 |
| 7 | B2 在用户 prompt 路径上起进程 | 硬超时 3 s；失败全程静默 |
| 8 | B2 重复注入 | 按文本去重（每 agent，10 分钟，上限 20） |
| 9 | 手写 client bundle 的格式契约漂移 | 对照 `dsh-context` 产物验证；格式错时卡片静默不出现 |
| 10 | 自动 sync 在大仓库可能到秒级 | `autoSync` 开关；实测后决定是否放上卡片 |
| 11 | 自动 sync 是写操作，只读项目会失败 | sync 失败降级为"继续查询 + 标注索引可能陈旧"，不整体失败 |
| 12 | shim 的 `stdio: 'inherit'` 实现细节 | 加断言；上游改管道就自己接 |
| 13 | 自动 sync 与 `init` 口径冲突（官方说别自己建索引） | 用户明确要求自动建：`autoIndex` + `autoIndexMaxFiles` 两道闸；工具发起的 `init` 仍走审批；README 说明这一有意偏离 |
| 14 | 自动 init 在超大仓库可能跑很久 | `autoIndexMaxFiles`（默认 1 万）在计数超限时立刻放弃，并把决定交回模型/用户 |
| 15 | 并发 `explore` 同时触发 init | 按 root 记录 in-flight 的构建 promise，同一根目录只跑一次 |

---

## 6. 不做的事

- 不重写索引器（tree-sitter + 自建 store）：官方 CLI 已覆盖 30+ 语言且有 Rust kernel。
- 不 import SDK：宿主 Node 版本不确定、同步 sqlite 阻塞主线程、无 `exports`。
- 不做 MCP server、不做 HTTP server、不做浏览器查看器。
- 不做后台 watcher。
- 不在设置面板上放状态行（理由见 ADR-0006）。
- 不自动 `init`。
