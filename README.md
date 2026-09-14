# @mrbbbaixue/dsh-codegraph

CodeGraph 代码知识图谱能力，以 DeepSeek Harness 插件的形式提供，**替换** dsh 既有的 MCP 接入方式
（`@deepseek-ai/dsh-mcp-client` + `codegraph serve --mcp`）。

- 决策理由：[`docs/adr/`](docs/adr/README.md)
- 术语：[`docs/glossary.md`](docs/glossary.md)
- 阶段与架构：[`PLAN.md`](PLAN.md)
- 逐文件编写顺序：[`docs/IMPL-PLAN.md`](docs/IMPL-PLAN.md)

---

## 为什么不是 MCP

dsh 已经能用 codegraph——通过 MCP。写这个插件不是为了「能用」，而是因为 MCP 这条路径丢掉了两样东西：

1. **提示词进不来。** codegraph 在 MCP `initialize` 响应里返回约 4.5 KB 的 `SERVER_INSTRUCTIONS`
   playbook（「reach for codegraph BEFORE grep/read」+ 四条 anti-pattern）。dsh 的 MCP 客户端不读
   `instructions` 字段，这段文本从来没进过模型上下文。插件把它做成 `systemPrompt.section`，每个请求都在，
   **subagent 也在**。
2. **没有自举能力。** MCP 默认只暴露 `codegraph_explore`；未索引时官方口径是「indexing is your decision」，
   不代跑 `init`。插件补上 `codegraph_index`，并且**第一次查询发现没有索引就直接建**（`autoIndex`，文件数
   上限 `autoIndexMaxFiles`，默认 1 万）；模型自己发起的 `init`/`index` 仍然弹审批。

另外：CLI 子进程不拉常驻 daemon，`serve --mcp` 会。

代价是失去 watcher，由**查询前自动 `sync`** 与**未索引时的自动 `init`** 补偿（见下）。

---

## 安装

```sh
dsh plugin --profile web add @mrbbbaixue/dsh-codegraph
```

本地开发（本仓库即插件）：

```sh
dsh plugin --profile web add F:/mrbbbaixue/dsh-codegraph
```

装完确认：

```sh
dsh --profile web --dump-default-config | grep codegraph
```

应当出现 `- id: dsh-codegraph` / `name: '@mrbbbaixue/dsh-codegraph'`。

### 从 MCP 接入迁移

装上本插件后，`~/.dsh/profiles/<name>/cordis.patch.yml` 里这行**应当移除**：

```yaml
- id: mcp-codegraph
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: codegraph
    command: codegraph
    args: [serve, --mcp]
```

留着它，模型会同时看到 `codegraph_explore` 和 `mcp__codegraph__codegraph_explore` 两个近乎同名的工具，
B1 文案还得解释该用哪个。移除后能力不减：本插件的 `explore` 与 MCP 工具返回的是同一个字符串
（源码里 `handler.execute('codegraph_explore', args)` 之后直接 `console.log`）。

迁移后模型侧唯一的变化是：多了一个 `codegraph_index`，以及每请求多约 1.5 KB 的指引。

---

## 工具面

默认 `surface: 'core'`，两个工具：

| 工具 | 作用 |
|---|---|
| `codegraph_explore` | 主力。给一个自然语言问题或一堆符号/文件名，一次调用返回相关符号的**逐字、带行号**源码（按文件分组）、它们之间的调用路径（含 grep 跟不到的动态分发跳转）、以及波及面摘要。返回的源码即已读，不要再 read。 |
| `codegraph_index` | `operation: init \| sync \| index`。`init` 首次建索引，`sync` 增量，`index` 全量重建。 |

`surface: 'full'` **追加** 8 个窄工具（不是替换）：`node`、`query`、`callers`、`callees`、`impact`、
`affected`、`files`、`status`。

只给两个是有实测背书的：官方 README 写明「one strong tool steers agents better than a menu of narrower
ones」，其余工具返回的东西 `explore` 已经内联带着。详见
[ADR-0004](docs/adr/ADR-0004-tool-surface-explore-and-index.md)。

---

## 设置

**设置 ▸ 插件 ▸ 插件配置 ▸ CodeGraph** 是一张和设置页其它插件卡片同形的面板：默认收缩，标题行（名称 +
一句话说明 + chevron）展开后是全部九个设置。**没有保存按钮**：控件一改就写。

| 字段 | 控件 | 默认 | 作用 |
|---|---|---|---|
| `guide` | 开关 | 开 | B1：把 CodeGraph 指引注入系统提示词（每请求约 1.5 KB） |
| `frontload` | 开关 | 开 | B2：结构性提问时在进入本轮前预取代码上下文 |
| `surface` | 下拉 | `core` | 工具面：`core`（2 个）或 `full`（10 个） |
| `autoSync` | 开关 | 开 | `explore` 之前跑一次增量 `sync` |
| `autoIndex` | 开关 | 开 | 第一次查询发现工作区没有 `.codegraph/`，直接跑 `init` |
| `autoIndexMaxFiles` | 数字框 | 10000 | 项目文件数超过它就**不再**自动建索引，改由模型/用户决定 |
| `executable` | 文本框 | `codegraph` | 显式指定运行时；留空即自动搜索 |
| `exploreTimeoutSec` | 数字框 | 120 | 单次 `explore` 的上限（秒） |
| `indexTimeoutSec` | 数字框 | 900 | `init` / `index` / 自动建索引的上限（秒） |

开关与下拉是设置的官方原语（`@deepseek-ai/dsh-client-ui-primitives` 的 `Switch`、与设置页同一套度量），
不是自绘的勾选框。

写入**热生效**：开关与下拉一改就写，工具与指引立刻按新值重注册，不需要重启。

文本与数值框在停手 400ms 后写入，离开输入框即时写入——面板上显示的永远是设置文档里的值，没有暂存与
保存这一步。写入走 `settingsScope` 的 `set` / `unset`：每次带最新 revision，快速连改按顺序落盘，所以
既不会把别处的改动覆盖掉，也不会漏掉最后一下。数字框后面跟着单位（秒 / 个文件），不是正整数的草稿不会写
出去，Host 侧的校验会拒绝它。清空 `executable` 或某个超时，等于撤掉这条用户覆盖，回落该部署的组装默认值；
某字段已被覆盖时，它那一行右上会出现一个**重置**，按一下就能只撤掉这一个字段。

面板上不放索引状态行，这是有意的：`codegraph status` 不带 `-p` 时读的是进程 cwd，而索引按项目根存放，
设置卡片拿不到会话/工作区上下文——那一行显示的会是「dsh 服务进程启动目录」的索引状态，与你在哪个项目
干活无关。见 [ADR-0006](docs/adr/ADR-0006-plugin-shape-and-settings-card.md)。

### 同一批字段也可以写在部署侧

面板上的每个字段都能写进 `cordis.patch.yml` 的 `config`，作为该 profile 的组装默认值（面板里清空覆盖
即回落到这里）：

```yaml
- insert:
    - id: dsh-codegraph
      name: '@mrbbbaixue/dsh-codegraph'
      config:
        autoSync: true            # 查询前自动 sync（默认开）
        autoIndex: true           # 未索引时自动 init（默认开）
        autoIndexMaxFiles: 10000  # 超过这么多文件就不自动 init
        executable: codegraph     # 指定 codegraph 运行时；默认 codegraph 表示"自动搜索"
        exploreTimeoutSec: 120     # explore 上限（秒）
        indexTimeoutSec: 900       # init / index / 自动索引上限（秒）
```

`autoSync` 是「自动 sync 在大仓库可能到秒级」这个风险的逃生阀；`autoIndexMaxFiles` 是「自动全量索引在超大
仓库可能跑很久」这个风险的逃生阀；`executable` 一旦配置就**优先于**自动搜索。两条路等价，选哪条看值该属于谁：
该 profile 的所有会话共用就写 YAML，只属于你就写面板。

---

## 索引生命周期：自动 sync 与自动 init

CLI 路径没有 watcher。实测后果不是「结果旧一点」，而是：

| 改了什么 | 未 sync 时 `explore` 的表现 |
|---|---|
| 改函数体 | 返回**新源码**（源码段从磁盘重读），带 staleness banner |
| **新增符号** | 返回 `No relevant code found`——**没有 banner、没有报错**，就像这个符号不存在 |

新增符号恰好是模型改代码时最高频的动作。留着这个盲区，B1 里「不要用 grep 复核 codegraph 结果」就成了陷阱。
所以 `codegraph_explore` 执行前会跑一次 `sync`（增量，实测 400–500 ms）。

`sync` 失败**不会**让查询失败：降级为「继续查询 + 标注索引可能陈旧」，这样只读项目仍可用。

**工作区没有索引时，`explore` 先跑 `init`。** 这是自动的，模型不必记得调工具，也不必先问一句：B1 要求
「调研代码先 explore」，而未索引时那句「CodeGraph isn't available here」会让这条指令直接落空。自动索引有
两道闸：

1. `autoIndex`（默认开）——关掉就回到「模型告知用户、由审批门禁决定」的老路径。
2. `autoIndexMaxFiles`（默认 10000）——文件数超过上限就不建，返回一条说明让模型去调 `codegraph_index`。
   计数只走目录树，跳过 `.` 开头的目录与 `node_modules`，并且**一旦超过上限立刻停止遍历**，所以判断本身
   只是几次 `readdir`。

`init` 失败（运行时缺失、只读目录、超时）会让这次 `explore` 直接失败并带上原因——索引建不出来时，含糊的
空结果比错误更糟。同一个根目录上并发发起的多个 `explore` 共用一次 `init`，不会互抢同一个索引文件。

预算上，自动 `init` 走 `indexTimeoutSec` 这一档（与 `codegraph_index` 的 `init` / `index` 相同），而这一次
`explore` 调用的整体上限是 `exploreTimeoutSec + indexTimeoutSec`——否则默认两分钟的查询预算会把一次合法的
全量索引掐死。`autoIndex` 关掉时，`explore` 的上限回到 `exploreTimeoutSec`。

---

## codegraph 运行时从哪来

按序解析，**每次调用重读**（不在启动期探测，缺运行时是可读的工具错误，不是启动崩溃）：

1. 配置的 `executable`（显式路径优先）
2. 插件自带的 `@colbymchenry/codegraph` 依赖（其 shim 兼管 `~/.codegraph/bundles` 缓存与自愈下载）
3. 磁盘上的自包含安装：`install.ps1` 布局、POSIX 版本化布局、或 shim 留下的缓存
4. `PATH` 上的 `codegraph`

第 3 级是本机实测补上的：镜像源会跳过平台包（只装 0.7 MB 的 thin 包），于是「装了依赖」不等于「有运行时」；
而官方 installer 装的那份运行时不在 npm 布局里，前两级和 PATH 都摸不到。没有这一级，第一次查询会去下载
~50 MB，而一份完整运行时正躺在磁盘上。

**Windows**：Node ≥ 22 禁止直接 spawn `.cmd`（`EINVAL`，CVE-2024-27980 加固），而 `resolveExecutable`
按 `PATHEXT` 正好会返回 `.cmd`。runner 把它映射回它包裹的安装（`node.exe --liftoff-only
--disable-warning=ExperimentalWarning lib/dist/bin/codegraph.js`），映射不到就明确报错，绝不硬 spawn。

---

## Model Experience

### Request surface and condition

#### What the model sees

`guide` 为真时，每个请求的系统提示词里多出下面这一段（约 1.5 KB，约 400 tokens），位置在
`TOOL_BASH`(1000) 之前、`TOOL_READ`(1100) 之前：

##### Verbatim text for this field

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

#### Token effect

固定：约 1.5 KB/请求（约 400 tokens）。`guide: false` 时为零。`surface: 'full'` 额外增加 8 个工具
schema，也是每请求固定成本。

#### KV Cache effect

前缀稳定、追加式。同一段文本每请求都以相同位置出现，不使已有可复用前缀失效。以下情况会改变请求、从而
影响复用：`guide` 开关切换、`surface` 在 core/full 之间切换（工具 schema 集合变化）、`exploreTimeoutSec`
等被改写（工具定义重注册）。

### Frontloaded prompt context (B2)

#### What the model sees

`frontload` 为真且 hook 命中时，本轮的用户消息之后追加一条 `source.kind === 'plugin'`、来源是本插件的
user 消息，内容是 `codegraph prompt-hook` 输出的 `<codegraph_context>` 块（上限 9000 字符）。

#### Token effect

条件性：非结构性提问、未索引工作区、hook 静默时为零。命中时最多 +9000 字符。

#### KV Cache effect

追加在当步消息末尾，不改动前面的前缀；因此不影响已可复用的部分。它被刻意标记为 plugin 来源而**不是**
user 来源，所以在会话日志与 UI 里不会与真人输入混淆。同一条 prompt 去重（每 agent、10 分钟、上限 20 条），
GUI 重发不会重复注入。

### Tool result text

#### What the model sees

`explore` 的 markdown：`**Exploration: <query>**` → `Found N symbols across M files` → 波及面 → 逐字源码
（按文件分组、带行号）→ 调用路径。`codegraph_index` 与 `full` 面的多数工具返回 CLI 的 JSON 或简短文本。

#### Token effect

有上限：`explore` 的 markdown 超过捕获上限时保留**头部**并在截断处写明「结果不完整」；JSON 类输出一旦
超限则**报错**而不是返回半截 JSON。

#### KV Cache effect

结果进入对话历史后按常规增长；截断标记的存在与否由单次输出大小决定，与历史无关。

---

## 已知限制与未完成的工作

- **自动 sync 在大仓库未测到秒级。** 实测数字来自 2 文件项目（400–535 ms）；大仓库可能显著更高。逃生阀是
  `autoSync` 开关。
- **B2 依赖 `codegraph prompt-hook` 这个 hidden 命令**（官方定位 Claude Code 专有）。官方契约是「任何失败
  都 exit 0 且无输出」，插件侧再加熔断（连续失败 2 次后本进程内不再尝试）。上游一旦改名或删除，B2 静默
  退化为无操作，不影响 B1 与工具面。
- **B2 的 3 秒预算是硬边界**：超时即放弃注入并终止子进程，绝不拖住一轮。
- **设置面板是手写的 lazy-CJS bundle**，格式契约靠复刻（官方 tsdown 预设未发布）。格式写错时卡片是
  **静默不出现**而不是报错；测试里有一条断言把浏览器半边的 `key` 与宿主半边的 settings namespace 钉在
  一起，防止两者漂移。面板的开关与 chevron 取自浏览器模块表里的
  `@deepseek-ai/dsh-client-ui-primitives`（与设置页其它卡片同一个包），所以控件观感跟随部署；该包一旦从
  模块表里消失，卡片会整体不出现，而不是退化成自绘控件。
- **客户端 bundle 的 `__ModuleLoader__.load({ id })` 与 `module.exports.name` 必须是完整包名**
  （`@mrbbbaixue/dsh-codegraph`），**不是** settings namespace。boot 图按包名为每一行建键，loader 也按
  同一个键取 factory；写成短名会在**页面加载时直接抛错**（`cannot resolve … not a row in the boot graph`），
  而不是静默失败。测试从 `package.json` 取包名与两者比对，改名时会在这里变红而不是在浏览器里。
  注意 settings namespace 恰好相反：schema 只接受小写字母/数字/连字符，`@` 与 `/` 会被注册直接拒绝。
- **不支持 deferred tool。** dsh 没有 MCP 那种「列出但不加载」的中间态，所以 `surface` 的含义比官方语境更硬：
  不给 schema 就等于彻底不可用。
- **首次查询会自动建索引**（`autoIndex` 默认开，文件数不超过 `autoIndexMaxFiles`）。这推翻 ADR-0005 早先
  「不自动 init」的决定（见该 ADR 的修订记录）：未索引时 `explore` 报「isn't available here」，B1 里
  「有问题先 explore」的指令就落空了。超过文件数上限、`autoIndex` 关掉或 `init` 失败时，才回到
  「模型告知用户 + 审批门禁」的路径。
- **`init` 会传 `-y`。** `codegraph init` 默认交互式；在管道里不带 `-y` 会一直挂在提示上直到超时。
  自动索引与工具调用走的是同一条命令。同时 `init` 不接受 `--force`，家目录/根目录路径直接拒绝。

---

## 开发

```sh
npm run dev:link   # 把引擎侧依赖链接进本地 node_modules（仅本地开发需要）
npm test           # 运行 test/run-plugin-test.mjs
```

测试自带 fixture（自己 `mkdtemp` 建小项目、跑真实 `codegraph init -y`），断言 `explore` 返回里包含 fixture
里的符号名；不依赖 `which`、不依赖 `/bin/bash`，Windows 与 POSIX 同命令。没有 codegraph 运行时时，
集成段自动跳过，其余断言照跑。
