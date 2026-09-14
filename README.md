# @mrbbbaixue/dsh-codegraph

CodeGraph 代码知识图谱能力，以 DeepSeek Harness 插件的形式提供。它**自己实现** codegraph 的 MCP 客户端，
不再依赖 `@deepseek-ai/dsh-mcp-client`。

- 决策理由：[`docs/adr/`](docs/adr/README.md)
- 术语：[`docs/glossary.md`](docs/glossary.md)
- 阶段与架构：[`PLAN.md`](PLAN.md)
- 逐文件编写顺序：[`docs/IMPL-PLAN.md`](docs/IMPL-PLAN.md)

---

## 架构：常驻会话查询，CLI 只做索引写入

查询走**每个项目一条常驻 MCP 会话**：插件 spawn 一个长期存活的 `codegraph serve --mcp -p <project>`，
由它背后的 detached daemon 持有**文件 watcher** 和唯一的 SQLite writer。于是：

- 一次查询**不再启进程**（CLI 每次调用要付 300–500 ms 冷启动）；
- 索引由 watcher 在写入后 1–2 秒自动同步，**不再需要查询前先 `sync`**。

写索引的动作（`init` / `index`）和 MCP 面没有对应物的命令（`affected`）仍走一次性 CLI 子进程——这些命令
不碰 daemon 的 writer lock，可以并存。

dsh 自带的 MCP 客户端丢掉两样东西，这也是插件必须自己实现客户端的理由：

1. **提示词进不来。** codegraph 在 MCP `initialize` 响应里返回约 4.5 KB 的 `SERVER_INSTRUCTIONS`
   playbook（「reach for codegraph BEFORE grep/read」+ 四条 anti-pattern）。dsh 的 MCP 客户端不读
   `instructions` 字段。插件把**这段文本整段**做成 `systemPrompt.section`（`lib/guide.js`），每个请求都在，
   **subagent 也在**——而官方自己的 MCP `instructions` 到不了 subagent。
2. **没有自举能力。** MCP 默认只暴露 `codegraph_explore`；未索引时官方口径是「indexing is your decision」，
   不代跑 `init`。插件补上 `codegraph_index`，并且**第一次查询发现没有索引就直接建**（`autoIndex`，文件数
   上限 `autoIndexMaxFiles`，默认 1 万）；模型自己发起的 `init`/`index` 仍然弹审批。

代价是插件会拉起一个**共享的常驻 daemon**（约 30 MB，与 Claude Code / Cursor 用的是同一个）。它设计上就是
detached 的：插件退出后由它自己的客户端扫描与 idle 超时回收，通常几分钟内消失。

### 会话进程的回收

常驻会话是本插件唯一会长期持有的进程，所以它的生命周期有明确的三道闸，任何一道都不依赖「用户会记得清理」：

| 闸 | 触发 | 效果 |
|---|---|---|
| 项目空闲回收 | `sessionIdleSec`（默认 900 秒）内没有任何查询 | 停掉该项目的会话进程；下次查询自动重建 |
| 数量上限 | 同时超过 8 个项目有活跃会话 | 淘汰最久没被用的那个空闲会话，不碰正在跑调用的 |
| 插件卸载 | dsh 关闭或插件被卸载（`ctx.effect` 的 disposer） | 停掉全部会话进程 |

三个细节值得写清：

- **空闲判定是懒的 + 定时兜底。** 每次调用前先就地清一遍已经空闲的会话（这样「换项目」立刻生效），
  另有一个 30 秒的定时器（`unref` 过，不会拖住宿主进程）负责「再也不会有下一次调用」的那种。
- **正在跑调用的会话永远不会被动。** 空闲回收与上限淘汰都跳过 `inFlight > 0` 的会话；上限因此可能被短暂
  超过，而不是掐断一次活着的调用。
- **共享 daemon 不由我们杀。** 它可能同时服务用户自己的 Claude Code / Cursor，杀掉会破坏别人的会话；它自己
  会在最后一个客户端离开后 30 秒扫描 + 300 秒 idle 超时内退出。插件崩溃或被打 SIGKILL 时也一样——proxy
  子进程有 PPID 看门狗（5 秒轮询）会自己退出，随后 daemon 按同样规则回收。

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
一句话说明 + chevron）展开后是全部十个设置。**没有保存按钮**：控件一改就写。

| 字段 | 控件 | 默认 | 作用 |
|---|---|---|---|
| `guide` | 开关 | 开 | B1：把 CodeGraph 指引注入系统提示词（每请求约 4.5 KB） |
| `frontload` | 开关 | 开 | B2：结构性提问时在进入本轮前预取代码上下文 |
| `surface` | 下拉 | `core` | 工具面：`core`（2 个）或 `full`（10 个） |
| `autoSync` | 开关 | 开 | CLI 回退路径上，查询之前跑一次增量 `sync`（走常驻会话的查询不需要它） |
| `autoIndex` | 开关 | 开 | 第一次查询发现工作区没有 `.codegraph/`，直接跑 `init` |
| `autoIndexMaxFiles` | 数字框 | 10000 | 项目文件数超过它就**不再**自动建索引，改由模型/用户决定 |
| `executable` | 文本框 | `codegraph` | 显式指定运行时；留空即自动搜索 |
| `exploreTimeoutSec` | 数字框 | 120 | 单次 `explore` 的上限（秒） |
| `indexTimeoutSec` | 数字框 | 900 | `init` / `index` / 自动建索引的上限（秒） |
| `sessionIdleSec` | 数字框 | 900 | 项目会话这么久没被查询就停掉、释放进程；下次查询自动重建（秒） |

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

`autoSync` 是「CLI 回退路径的自动 sync 在大仓库可能到秒级」这个风险的逃生阀；`autoIndexMaxFiles` 是「自动
全量索引在超大仓库可能跑很久」这个风险的逃生阀；`executable` 一旦配置就**优先于**自动搜索。两条路等价，
选哪条看值该属于谁：该 profile 的所有会话共用就写 YAML，只属于你就写面板。

---

## 索引生命周期：watcher 自动同步 + 自动 init

查询走常驻会话时，索引由**后台 daemon 的文件 watcher** 维护：源码写入后经约 2 秒的 debounce（待同步文件
≤2 个时 300 ms）自动增量同步。这就是「不需要查询前先 `sync`」的来源。

watcher 覆盖不到的地方有四类提示，全部由 codegraph 服务端自己发出，插件不改写、也不补写：

| 提示 | 出现条件 | 需要 watcher |
|---|---|---|
| `⚠️ Some files referenced below were edited since the last index sync — …`（前置 banner） | 响应里提到的文件还在「待同步」集合里 | 是 |
| `(Note: N file(s) elsewhere in this project are pending index sync …)`（后置 footer） | 有文件待同步，但这份响应没提到它们 | 是 |
| `⚠ changed on disk after the last index sync`（文件级 header，或响应末尾的引用块） | 发结果时按 stat+hash 发现该文件已漂移：**小文件整份给当前字节**，大文件省略源码并说明原因 | **否** |
| `⚠️ CodeGraph auto-sync is DISABLED — …`（前置 banner） | watcher 存在，且已**永久 degrade** | 是，且 watcher 对象必须存在 |

**最后一行不等于「所有关掉监听的情况都会提示」——这是最容易搞错的一点。** `CODEGRAPH_NO_WATCH=1` 与
WSL2 的 `/mnt/*` 走的是 engine 的 `watchDisabledReason` 分支：它只往 stderr 写一行、**不创建 watcher
对象**，于是 `isWatcherDegraded()` 恒为 false，模型侧一条提示都没有。会 degrade 的是 watcher 已经起来之后
的**运行期失败**：inotify/EMFILE 配额耗尽、写锁重试超预算、连续 sync 失败超预算。

CLI 回退路径上只有第三类会出现——那条路径的 CodeGraph 实例没有 watcher，「待同步」集合恒为空。

**未索引时 `explore` 先跑 `init`。** 这是自动的，模型不必记得调工具，也不必先问一句：B1 要求「调研代码先
explore」，而未索引时那句「CodeGraph isn't available here」会让这条指令直接落空。自动索引有两道闸：

1. `autoIndex`（默认开）——关掉就回到「模型告知用户、由审批门禁决定」的老路径。
2. `autoIndexMaxFiles`（默认 10000）——文件数超过上限就不建，返回一条说明让模型去调 `codegraph_index`。
   计数只走目录树，跳过 `.` 开头的目录与 `node_modules`，并且**一旦超过上限立刻停止遍历**，所以判断本身
   只是几次 `readdir`。

`init` 失败（运行时缺失、只读目录、超时）会让这次 `explore` 直接失败并带上原因——索引建不出来时，含糊的
空结果比错误更糟。同一个根目录上并发发起的多个 `explore` 共用一次 `init`，不会互抢同一个索引文件。

预算上，自动 `init` 走 `indexTimeoutSec` 这一档（与 `codegraph_index` 的 `init` / `index` 相同），而这一次
`explore` 调用的整体上限是 `exploreTimeoutSec + indexTimeoutSec`——否则默认两分钟的查询预算会把一次合法的
全量索引掐死。`autoIndex` 关掉时，`explore` 的上限回到 `exploreTimeoutSec`。

### CLI 回退路径仍然先 `sync`

MCP 面没有对应物的命令（`affected`）、以及未索引项目上的查询，走一次性 CLI 子进程。这条路径没有 watcher，
`autoSync`（默认开）就是它的新鲜度补偿：执行前跑一次增量 `sync`（实测 400–500 ms）。

留着它不是冗余，因为 CLI 路径的盲区同样致命：

| 改了什么 | 未 sync 时 CLI 查询的表现 |
|---|---|
| 改函数体 | 返回**新源码**（源码段从磁盘重读），带 staleness banner |
| **新增符号** | 返回 `No relevant code found`——**没有 banner、没有报错**，就像这个符号不存在 |

`sync` 失败**不会**让查询失败：降级为「继续查询 + 标注索引可能陈旧」，这样只读项目仍可用。

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

`guide` 为真时，每个请求的系统提示词里多出 codegraph 官方 `initialize.instructions` 的**全文**，位置在
`TOOL_BASH`(1000) 之前、`TOOL_READ`(1100) 之前。文本在 [`lib/guide.js`](lib/guide.js)（约 4.5 KB，
约 1600 tokens），不在本文件重复。

相对上游原文只有五处改动，每一处都是**在 dsh 里会变成假话**的句子：

| 改动 | 为什么 |
|---|---|
| 补上 `codegraph_index` | 原文说「There is a single tool」；本插件 `core` 面有两个，且 index 是插件自造的 |
| 删掉 deferred tool 那句 | dsh 没有「列出但延迟加载」的中间态（ADR-0004），不注册就是不存在 |
| `projectPath` → `path` | 本插件的参数名；同时删掉「no live watcher」那个括号——每条常驻会话都有 watcher |
| 重写未索引那条限制 | 原文让模型「别自己跑 init」；本插件第一次查询就会建索引 |
| 删掉 `CODEGRAPH_EXPLORE_DEDUP` 一段 | 那个去重只在「一连接一上下文」时安全；本插件把整个 dsh 进程的多会话复用在一条连接上，去重会吞掉别的会话没见过的源码 |

#### Token effect

固定：约 4.5 KB/请求（约 1600 tokens），每个请求、**包括 subagent 的请求**。`guide: false` 时为零。
`surface: 'full'` 额外增加 8 个工具 schema，也是每请求固定成本。

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
（按文件分组、带行号）→ 调用路径。这是 codegraph 服务端的同一个字符串——常驻会话走 `tools/call` 拿到的
`content[0].text`，与 `codegraph explore` 的 stdout 逐字相同。`full` 面的多数工具同理；
`codegraph_index` 与 `affected` 返回 CLI 的 JSON 或简短文本。

#### Token effect

有上限：`explore` 的 markdown 超过捕获上限时保留**头部**并在截断处写明「结果不完整」；JSON 类输出一旦
超限则**报错**而不是返回半截 JSON。

#### KV Cache effect

结果进入对话历史后按常规增长；截断标记的存在与否由单次输出大小决定，与历史无关。

---

## 已知限制与未完成的工作

- **常驻 daemon 是共享的、detached 的。** 插件退出后它不会立刻死，而是等自己的客户端扫描（30 s）与 idle
  超时（300 s）回收，通常几分钟内消失。Windows 上它持有项目目录里的索引文件，所以**只要 daemon 还活着，
  那个项目目录就删不掉**。用 `codegraph daemon` 可以手动停它。
- **daemon 与 proxy 的版本必须完全相等。** codegraph 升级后，旧 daemon 会让新会话一律降级到进程内只读模式
  ——查询仍可用，但自动同步失效。升级后要手动停掉旧 daemon。
- **CLI 的 `sync` 在 daemon 正在同步时可能静默返回空结果**（拿不到 `codegraph.lock`）。所以 `autoSync` 只是
  CLI 回退路径的尽力而为，不是可靠的新鲜度保证；可靠的那条是 watcher。
- **监听关闭时不一定有提示。** `CODEGRAPH_NO_WATCH=1` 与 WSL2 的 `/mnt/*` 只是不装 watcher、不置 degraded，
  模型侧收不到任何信号（只有 daemon 的 stderr）。只有**运行期** degrade（inotify/EMFILE 耗尽、写锁重试
  超预算、连续 sync 失败超预算）才会给出 `⚠️ CodeGraph auto-sync is DISABLED` banner。在这类环境里索引
  是否新鲜要自己判断——`codegraph_index` 的 `sync`，或看 `codegraph_status` 的 watcher 状态。
- **CLI 回退路径的自动 sync 在大仓库未测到秒级。** 实测数字来自 2 文件项目（400–535 ms）；大仓库可能显著
  更高。逃生阀是 `autoSync` 开关。
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
