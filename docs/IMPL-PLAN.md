# dsh-codegraph 编写计划

> 上位文档：[PLAN.md](../PLAN.md)（架构与阶段 P0–P7）、[docs/adr](adr/README.md)（决策理由）、[glossary.md](glossary.md)（术语）。
> 本文件只回答三个问题：**先写哪个文件**、**每处接口以什么为准**、**每一步拿什么验收**。
>
> **状态：G0–G9 全部实现完毕**，插件已装入 `~/.dsh/profiles/web`（`link:` 到本仓库），
> `dsh --profile web --dump-config` 与 `--dump-default-config` 均只剩本插件行，`npm test` 39/39 绿。
> 唯一未做机器验证的验收项是 P5 的「设置页出现卡片」——需要人工在浏览器里看一眼。
>
> 文中每条"以什么为准"都已在当前环境核实并标了 `file:line`；**未核实的条目一律不写进计划**，改列进 §3 的取证工作项（标 `[取证]`），不靠推测写码。

---

## 0. 完成定义

产出一个可发布、可安装、**零构建**的单包 `@mrbbbaixue/dsh-codegraph`。以下五条同时成立才算完成：

1. `dsh plugin --profile web add F:/mrbbbaixue/dsh-codegraph` 后，`~/.dsh/profiles/web/cordis.patch.yml` 里的 `mcp-codegraph` 行可以删掉，而 codegraph 能力仍在（且模型第一次就知道该用它）。
2. 未索引的中型仓库：模型调 `codegraph_explore` → 报未索引 → 征求同意 → `codegraph_index`（**弹审批**）→ 再 `explore` 回答。
3. 已索引仓库：结构性中文提问 → 一次调用拿到源码与调用链，不退回 grep/read。
4. 设置页「插件配置」出现 CodeGraph 卡片，三个开关可存、可重置、可丢弃，值落 `~/.dsh/settings.yaml`。
5. `test/run-plugin-test.mjs` 在没有手建 fixture、没有 `which`、没有 `/bin/bash` 的前提下，在 Windows 与 POSIX 上都是绿的。

---

## 1. 地面真相（2026-09-14 实测）

### 1.1 环境

| 项 | 实测值 |
|---|---|
| dsh | `0.1.5-rc.1`，装在 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh` |
| 第一方包 | 上述目录下 `node_modules/@deepseek-ai/` 有 **239** 个包，含 `dsh-tools` / `dsh-llm` / `dsh-system-prompt` / `dsh-subprocess` / `dsh-settings` / `dsh-agent-loop` / `dsh-user-approval` / `dsh-client-ui-settings-plugins` |
| profile | `~/.dsh/profiles/web`（一个 pnpm 项目），`dsh.profile.bundles` 已含 13 个包（含 `dsh-context` 0.51.1） |
| **要替换的既有行** | `~/.dsh/profiles/web/cordis.patch.yml` 的 `mcp-codegraph`：`@deepseek-ai/dsh-mcp-client` + `command: codegraph` + `args: [serve, --mcp]` |
| Node | `v22.23.2` |
| **codegraph** | `1.6.0`，`install.ps1` 布局：`%LOCALAPPDATA%\codegraph\current\{node.exe, bin, lib}` |
| npm 布局 | **未安装**——`~/.codegraph/bundles/` 目录不存在 |
| PATH | Windows PATH 上 `codegraph` → `…\current\bin\codegraph.cmd`；git-bash 的 PATH 上**没有** codegraph |
| 残留 | `~/.codegraph/daemons/` 有 2 个 json（`serve --mcp` 留下的） |
| 全局 `AGENTS.md` | `~/.dsh/AGENTS.md` 45–81 行是一段手写的 CodeGraph 铁律，第 81 行要求"没初始化就立刻建索引，**不要问用户**" |

### 1.2 codegraph 本地安装的真实入口

`%LOCALAPPDATA%\codegraph\current\bin\codegraph.cmd` 全文只有一行：

```
@"%~dp0..\node.exe" --liftoff-only --disable-warning=ExperimentalWarning "%~dp0..\lib\dist\bin\codegraph.js" %*
```

→ runner 的**第四级回退可以直接复刻这一行**。`--liftoff-only` 正是 ADR-0001 里 SDK 注释提到的 V8 Zone OOM 规避参数，官方 CLI 自己也在用。

### 1.3 CLI 面（实测 `--help`）

| 命令 | 参数 | 备注 |
|---|---|---|
| `init [path]` | `-f/--force`、`-y/--yes`、`-v`、`-i`（已废弃） | **默认交互式**；`-y` = 跳过所有提示取默认值 |
| `index [path]` | `-f/--force`、`-q/--quiet`、`-v` | 全量重建；`--force` 才允许家目录/根目录 |
| `sync [path]` | `-q/--quiet` | 增量 |
| `explore <query...>` | `-p/--path <path>`、`--max-files <number>` | query 是**变参**；**没有 `--json`** |
| `prompt-hook` | — | **不在 `--help` 列表里（hidden）**，见 1.4 |

**两个必踩的坑（PLAN.md 未写）：**

1. `codegraph init` **不带 `-y` 会挂在交互提示上**。我们在管道里跑它，它拿不到 TTY 却仍在等输入，结果是工具调用一直挂到 `indexTimeoutMs`（900 s）耗尽。`init` 必须带 `-y`；`index` 无 `-y` 参数，需在 W2.2 验证它在无 TTY 下是否同样会提示。
2. `explore` 的项目路径是 `-p/--path`，**不会**因为我们设了 `cwd` 就自动生效（`cwd` 只影响相对路径解析）。`path` 参数必须显式翻译成 `-p <path>`。

### 1.4 `prompt-hook` 契约实测

`codegraph prompt-hook` 不在 `--help` 的 Commands 列表里，但可执行。实测：

```
stdin  = {"prompt":"dsh-codegraph 插件的 runner 是怎么解析可执行文件的","cwd":"f:/mrbbbaixue/dsh-codegraph"}
stdout = 0 字节
exit   = 0
```

（该项目未索引。）这一次调用同时验证两件事：命令确实存在；**失败与"无索引"两条路径确实静默 exit 0**。所以 B2 的"任何失败都静默跳过"不是我们加的纵深防御，而是官方设计——我们真正要处理的只有"注入了什么"和"重复注入"。

### 1.5 宿主 API 契约（写代码时以此为准）

路径前缀省略为 `<dsh>` = `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`。

| 用途 | 契约 | 出处 |
|---|---|---|
| B1 section | `section(section: PromptSection): () => void` | `<dsh>dsh-system-prompt/lib/types/index.d.ts:233` |
| B1 order | `getSectionOrder(name: PromptSectionOrderName): number` | 同上 `:239` |
| 工具定义 | `defineTool(options)`；`options.timeoutMs?: number` | `<dsh>dsh-tools/lib/types/schema.d.ts:239`、`:195` |
| 超时校验 | `timeoutMs` 非正有限数直接 `throw`（**不是静默忽略**） | `<dsh>dsh-tools/lib/types/schema.js:290` |
| 审批门禁 | `'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>)` | `<dsh>dsh-tools/lib/types/index.d.ts:38` |
| 审批决策 | `PreToolDecision = {kind:'allow'} \| {kind:'deny',reason} \| {kind:'ask',reason?}` | 同上 `:419–427` |
| 超时落地 | `'tools/execute'(exec: ToolDispatchExecution, next)` — 超时策略在这里换 `exec.signal` | 同上 `:49` |
| B2 挂点 | `dispatch.waterfall('agent/pre-step', {messages: claimed, turn, step, signal}, () => ({kind:'enter', messages: [...claimed, context]}))` | `<dsh>dsh-agent-loop/lib/index.js:894` |
| B2 决策 | `kind: 'enter' \| 'reject'`；`reject` 会让该 turn 以 `blocked` 收尾 | 同上 `:894–906` |
| 设置命名空间 | `register(ns, schema)` — `ns` 唯一，重复注册 fail loud；schema 是 schemastery | `<dsh>dsh-settings/lib/types/index.d.ts:206–211` |
| 子进程 | `resolveExecutable(command, env?, signal?): Promise<string>`（**异步**）；`spawn(spec): SubprocessHandle` | `<dsh>dsh-subprocess/lib/types/index.d.ts:88`、`:96` |
| 审批服务 | 缺 answerer 时请求解析为 `unavailable` → **fail closed**，我们不需要自己实现拒绝逻辑 | `<dsh>dsh-user-approval/README.md` |
| 卡片 slot | 配置页 = 「Host 注册的 namespace」∩「挂在该 key 上的卡片」；`settings.plugin.item` 以 namespace 为 key | `<dsh>dsh-client-ui-settings-plugins/README.md` |
| client bundle 骨架 | `window.__ModuleLoader__.load({id, factory})`；`factory(require)` 收 `react` / `@deepseek-ai/dsh-client-ui-primitives`；`module.exports = {name, inject:['slots','locale'], apply}` | `~/.dsh/profiles/web/node_modules/dsh-context/lib/client.js:9763–9789` |

可抄的注册骨架（`dsh-context/lib/client.js:9763–9783`，逐字对照，不要凭记忆写）：

```js
ctx.inject(["settingsScope"], (raw) => {
  const c = raw;
  const binder = c.settingsScope;
  if (binder === void 0) return;
  c.effect(() => settings.attach(binder.bind({ namespace: NS })), "…");
  const SettingsCard = makeSettingsCard(kit);
  c.slots.inject("settings.plugin.item", () => {
    return c.slots.register({
      name: "settings.plugin.item",
      key: NS,
      locale: NS,
      inject: () => ({ hooks: {…}, set: (field, value) => settings.set(field, value) })
    }, (props) => (0, react.createElement)(SettingsCard, props));
  });
});
```

---

## 2. 相对 PLAN.md 的修正（写码前先改口径）

| # | 修正 | 影响 |
|---|---|---|
| **D1** | 解析链**缺一级**。PLAN §2.2 的链是「插件内依赖 → `~/.codegraph/bundles` → PATH」，但本机真正装着的运行时在 `%LOCALAPPDATA%\codegraph\current`，**三级里没有一级能找到它**：npm 布局未装、bundles 不存在、PATH 命中 `.cmd`（直接 spawn 必 EINVAL）。 | 不加这一级，本机第一次 `explore` 会去下载 ~50 MB，而一份 1.6.0 的完整运行时正躺在磁盘上。→ **W1.1 / W1.2** |
| **D2** | `@deepseek-ai/dsh-client-ui-primitives` **不是** node_modules 里的包。它被几十个 client bundle `require()`，但 dsh 安装目录与 web profile 下都没有这个目录——它由浏览器模块表在运行时提供。 | peer 必须标 `optional`，且**不能**把它写进 `dependencies` 或顶层 import，否则安装/启动即失败。→ **W0.1** |
| **D3** | `agent/pre-step` 的**默认决策已经带了一条消息**：`{kind:'enter', messages:[...claimed, context]}`，`context` 是 runtime-context 快照（未变化时为 `undefined`）。 | B2 必须"追加"而不是"替换 `messages`"，否则会静默吃掉每步的 runtime context。→ **W5.1** |
| **D4** | `~/.dsh/AGENTS.md:81` 的全局铁律是"没初始化就**立刻建索引，不要问用户**"，与 ADR-0005 的 `init`/`index` 审批门禁**正面冲突**。 | 装上插件后，模型的 B1 提示词与用户的全局 AGENTS.md 会给出相反指令。必须在 P7 明确处理（改写 AGENTS.md 那一段），否则是必然的行为抖动。→ **W8.2** |
| **D5** | `timeoutMs` 非正有限数会让 `defineTool` **直接抛错**，不是静默忽略。 | `exploreTimeoutMs` / `indexTimeoutMs` 从 Config 进来时必须校验为正；`cordis.patch.yml` 里写错一个 0 就是启动期崩溃。→ **W0.3 / W2.1** |
| **D6** | dsh 第一方包不装在 profile 的可解析范围内（它们在 dsh 自己的嵌套 `node_modules` 里）。 | PLAN §1 里那 5 条 `peerDependencies` 可能在 profile 里解析不到，pnpm 会报 unmet peer。→ **W0.1** 需要先 dry-run 一次看 pnpm 报什么，再决定是全标 `optional` 还是收缩声明面。 |
| **D7** | `codegraph init` **不带 `-y` 会挂在交互提示上**。管道里拿不到 TTY 却仍在等输入，结果是工具调用一直挂到 `indexTimeoutMs`（900 s）耗尽。 | `init` 必须带 `-y`；`index` 无 `-y` 参数，需在 W2.2 验证它在无 TTY 下是否同样会提示。 |
| **D8** | `explore` 的项目路径是 `-p/--path`，**不会**因为我们设了 `cwd` 就自动生效（`cwd` 只影响相对路径解析）。 | `path` 参数必须显式翻译成 `-p <路径>`；显式路径一律翻译成绝对路径，不依赖 cwd。 |

### 实现中补记的两条

| # | 事实 | 影响 |
|---|---|---|
| **D9** | 工具参数 schema 里 **`required: false` 会被拒绝**（`parameters.x.required must be true when present`）。 | 可选参数只能**整个省略** `required` 键，不能写 `false`。已写进 `textTool` 的 JSDoc，防止回改。 |
| **D10** | 引擎侧 `settings.installSection` 的 `setSource`/`onChange` **在 `ctx.inject` 回调里异步触发**，不在 `apply()` 内同步发生。 | 「没有 settings provider 时兜底一次」的写法会导致启动时重复注册一次。改为对**生效配置取指纹**去重：配置没变就不重新注册。 |
| **D11** | 客户端 bundle 的 `__ModuleLoader__.load({ id })` 与 `module.exports.name` **必须是完整包名**（对照 `@linxin666/dsh-client-ui-git-graph`、`dsh-context`），**不是** settings namespace。 | 写成短名时 boot 图按包名找不到 factory，**页面加载时直接抛错**：`client-modules: cannot resolve "…" — not a row in the boot graph`。健康检查方式是比对「boot 行的 `id`」与「被服务 bundle 内的 `id`」。测试已从 `package.json` 取包名双向比对。注意 namespace 反向受限：只接受小写字母/数字/连字符。 |

---

## 3. 工作分解

每项格式：**产出 / 内容 / 验收 / 依赖**。`[取证]` 表示动作本身是"去看一眼真实行为再写码"。

### G0 骨架（对应 P0）

**W0.1 `package.json`**
产出：`package.json`
内容：按 PLAN §1 写，但落实 D2/D6——`peerDependenciesMeta` 把 `@deepseek-ai/dsh-client-ui-primitives` 标 `optional`；其余 5 条先按 PLAN 声明，**跑一次安装看 pnpm 报什么再定稿**。`files` 只列 `lib` / `cordis.patch.yml` / `README.md` / `docs`。
验收：`dsh plugin --profile web add F:/mrbbbaixue/dsh-codegraph` 成功且 pnpm 无 unmet-peer 报错（若有，改为全部 `optional` 并记录理由）。
依赖：—

**W0.2 `cordis.patch.yml`**
产出：`cordis.patch.yml`
内容：`- insert: [{ id: dsh-codegraph, name: '@mrbbbaixue/dsh-codegraph' }]`。形态对照已在用的 `F:/mrbbbaixue/dsh-status-rotator/cordis.patch.yml`。
验收：与 `dsh plugin add` 后写进 profile 的行一致。
依赖：—

**W0.3 host 骨架**
产出：`lib/index.js`（具名导出 `name`/`inject`/`Config`/`apply`，**无 default**）、`lib/guide.js`、`lib/runner.js`（先抛 not-implemented）
内容：`Config` 用 schemastery；`exploreTimeoutMs`/`indexTimeoutMs` 加正数校验（D5）；`apply` 先空实现。前三个开关（`guide`/`frontload`/`surface`）的**实际生效值必须来自 `ctx.settings`**，`apply(ctx, config)` 的入参只是组装默认值。
验收：`dsh --profile web --dump-default-config` 出现本插件行；启动无报错、无警告。
依赖：W0.1、W0.2

**W0.4 `README.md` 骨架**
产出：`README.md`
内容：安装、迁移、三个开关、已知限制，正文留空待 P7 填。
验收：目录结构存在。
依赖：—

**W0.5 装进 profile 并确认 patch 层生效**
产出：`~/.dsh/profiles/web/{package.json,cordis.patch.yml}` 的改动
内容：先 `add` 本仓库路径（本地开发用 `link:F:/mrbbbaixue/dsh-codegraph` 更快，与 `dsh-status-rotator` 同法）。
验收：`dsh --profile web` 能起来；本插件行在 bundle 层或 patch 层可见；`patchReload: live` 下改 `lib/*.js` 无需重装。
依赖：W0.1–W0.4

### G1 runner（对应 P2 前半，**先于任何工具**）

**W1.1 解析链**
产出：`lib/runner.js` → `resolveCommand()`
内容：**四级**（D1）：① 插件内 `createRequire(import.meta.url).resolve('@colbymchenry/codegraph/npm-shim.js')` → ② `~/.codegraph/bundles/<platform>-<arch>-<version>/` → ③ PATH 上的 `codegraph`（`ctx.subprocess.resolveExecutable`，注意它是 **Promise**）→ ④ `%LOCALAPPDATA%\codegraph\current\`（POSIX 为 `~/.codegraph/versions/*/current`）。**每次调用重读**，不在 `apply()` 期探测。
验收：本机命中第 ④ 级；删掉/改名该目录时能顺延到 ②，且报错可读。
依赖：W0.3

**W1.2 调用形式构造**
产出：`lib/runner.js` → `buildInvocation()`
内容：命中 ①→`[node, shim, ...args]`（shim 自处理 Windows `.cmd` 与自愈下载）；命中 ④→复刻 1.2 那行 `[<install>/node.exe, '--liftoff-only', '--disable-warning=ExperimentalWarning', '<install>/lib/dist/bin/codegraph.js', ...args]`；命中 ③ 且解析结果是 `.cmd`/`.bat` → **绝不直接 spawn**（Node ≥22 必 EINVAL），转 ④ 或以可读错误终止。
验收：**单测**：构造一个 `C:\…\codegraph.cmd` 路径，断言它没有作为 argv[0] 进 `spawn`；本机真实调用 `--version` 返回 `1.6.0`。
依赖：W1.1

**W1.3 执行与错误归一**
产出：`lib/runner.js` → `runCodegraph(args, {cwd, signal, timeoutMs})`
内容：`ctx.subprocess.spawn`（**无 `timeoutMs` 字段，只有 signal**，所以超时靠工具侧 `defineTool.timeoutMs`）；stdout/stderr 分别收集；`stripVTControlCharacters`；exit ≠ 0 抛错，细节优先 stderr、再 stdout，两者都空时至少带 exit code 与完整命令行。`[取证]` 在 W1.3 里对**已安装的 shim** 做一次 stdio 契约探测：跑 `--version`，断言 shim 的 `stdio:'inherit'` 没有导致 stdout 抓不到。抓不到说明上游改成了管道重定向，就自己接。
验收：正常路径返回字符串；错误路径的 message 里能看到 CLI 自己的话；`kill` 能终止进程。
依赖：W1.2

**W1.4 工作区解析**
产出：`lib/runner.js` → `resolveRoot(exec, args)`
内容：默认 root = `exec.agent?.session?.header?.cwd`；工具参数 `path` 覆盖。**不设 `cwd || '/'` 兜底**——缺 cwd 且无 `path` 时直接抛错。找 `.codegraph/` 最多向上 12 层，且不越出会话工作区。
验收：在子目录里调用能命中项目根的索引；无 cwd 且无 path 时抛错而不是落 `/`。
依赖：W1.1

### G2 工具面 core（对应 P2 后半）

**W2.1 `codegraph_explore`**
产出：`lib/index.js` 工具注册
内容：`defineTool({name:'codegraph_explore', parameters:{query, path?, maxFiles?}, timeoutMs: config.exploreTimeoutMs, execute})`。参数映射到 CLI：`query` 是**变参**（逐词展开或整串传一个 arg，需按 W2.0 取证结论定）；`path` → `-p <path>`（不会自动继承 cwd，见 1.3）。
验收：在真实仓库返回含真实符号名的逐字源码；未索引时错误文案可读（不是栈）。
依赖：W1.4

**W2.0 `[取证]` explore 参数形态**
内容：拿一个小项目 `init` 后分别试「整串一个 arg」与「按空格拆多个 arg」，看哪个命中。不猜。
验收：结论写进 W2.1 的实现与测试。
依赖：W2.2（需要先有索引）

**W2.2 `codegraph_index`**
产出：`lib/index.js` 工具注册
内容：`operation: 'init' | 'sync' | 'index'` + `path?`。`init` **必须带 `-y`**（1.3 的坑）；`index` 传 `--force` 仅当用户显式要求；`sync` 传 `-q`。`timeoutMs: config.indexTimeoutMs`。**另需验证 `index` 在无 TTY 下是否会提示**——会的话同样需要绕过手段，否则这条路不可用。
验收：三个 operation 各真实跑一次；`init` 在无 TTY 下不挂。
依赖：W1.4

**W2.3 查询前自动 `sync`**
产出：`lib/index.js` 的 explore 前置
内容：`autoSync` 为真时，`explore`（与 `full` 面的 `node`）执行前先 `sync`。**sync 失败不整体失败**：降级为"继续查询 + 在结果里标注索引可能陈旧"（只读项目场景）。
验收：改一个源文件后立刻查，结果反映新代码；新增符号后立刻查，**能找到它**；把 `.codegraph/` 设为只读时仍能查询，且结果带陈旧标注。
依赖：W2.1、W2.2

**W2.4 输出处理**
产出：`lib/index.js` 结果整形
内容：**JSON 结果绝不按字符盲截**（截断后模型分不清"CLI 出错"与"插件截断"）。只在 `explore` 的 markdown 上截断，且截断处写明"结果不完整"。
验收：超大输出被截断时模型能读到明确的不完整标记。
依赖：W2.1

### G3 B1（对应 P1，可与 G1 并行）

**W3.1 `lib/guide.js` 定稿**
产出：`lib/guide.js`
内容：PLAN §2.3 的英文草稿，约 1.5 KB，工具名映射到 `codegraph_explore` / `codegraph_index`，补上官方没有的自举路径。单独成文件以便评审。
验收：字数与目标量级一致；工具名无遗漏、无多余。
依赖：—

**W3.2 section 注册**
产出：`lib/index.js`
内容：`ctx.systemPrompt.section({name:'tool:codegraph', order, text})`；`order = getSectionOrder('TOOL_BASH') - 10`，**不硬编码**。`[取证]` `getSectionOrder` 的入参类型是 `PromptSectionOrderName`（受约束的字符串联合），先确认 `'TOOL_BASH'` 在联合内、以及 `TOOL_BASH` 在该版本的真实值。**整体 try/catch + 常量回退**（上游改名时不能崩）。
验收：新会话里模型能复述"优先用 codegraph_explore 而不是 grep"；`guide: false` 后消失；subagent 也生效。
依赖：W0.3、W3.1

### G4 审批门禁（对应 P3）

**W4.1 `tools/pre-execute` 的 `ask`**
产出：`lib/index.js`
内容：`ctx.on('tools/pre-execute', async (exec, next) => …)`；`exec.name === 'codegraph_index'` 且 `operation` 是 `init`/`index` → 返回 `{kind:'ask', reason}`；`sync` 与其余工具 `return next()`。缺审批服务时由 `dsh-user-approval` 的 `unavailable` 语义兜底 fail-closed（1.5），不需自己实现。
验收：`init` 弹审批；拒绝后 `.codegraph/` 不产生；`sync` 不弹。
依赖：W2.2

**W4.2 路径白名单**
产出：`lib/index.js`
内容：`operation: 'init'` **不接受 `--force`**；根目录 / 家目录路径直接拒绝（官方用 `--force` 才放行，我们把这条路封死）。
验收：对 `C:\` 与 `%USERPROFILE%` 调 `init` 直接拒绝，且拒绝理由可读。
依赖：W4.1

### G5 B2（对应 P4）

**W5.1 `agent/pre-step` 监听**
产出：`lib/index.js`
内容：`await next()` 拿到默认决策后，判断这一步是否携带**新的真实用户消息**（`role === 'user'` 且来源不是本插件）。命中则**追加**到 `decision.messages` 末尾——**必须保留默认决策里那条 runtime-context 快照**（D3）。注入消息来源用 plugin，**不伪造 `user`**。
验收：单测断言默认决策里的 `context` 消息在改写后仍存在。
依赖：W0.3

**W5.2 去重表**
产出：`lib/index.js`
内容：按 prompt 文本查重，每 agent 一个 `Map`，10 分钟过期，上限 20 条。GUI 重发/重试会让同一条 prompt 多次进 `nextTurn`，不去重会重复注入十几 KB。
验收：同一条 prompt 连续两次触发只注入一次。
依赖：W5.1

**W5.3 `prompt-hook` 子进程**
产出：`lib/index.js`
内容：spawn `codegraph prompt-hook`，stdin 写 `{prompt, cwd}`，**硬超时 3 s**；stdout 有 `<codegraph_context>` 块才注入。1.4 已确认失败与无索引都是 exit 0 无输出，所以"静默"是既有行为，不要为它加告警噪音。
验收：结构性中文 prompt 注入 `<codegraph_context>`；非结构性静默；未索引静默；超时 3 s 后放弃，不拖 turn。
依赖：W1.1、W5.1

**W5.4 熔断**
产出：`lib/index.js`
内容：同进程内连续失败 2 次后不再尝试。**不做启动探测**、不落盘、不阻塞启动。
验收：单测注入两次失败后，第三次不再 spawn。
依赖：W5.3

### G6 client 卡片（对应 P5）

**W6.1 host 侧 `ctx.settings.register`**
产出：`lib/index.js`
内容：`NS = 'dsh-codegraph'`；schemas 只含三个开关。`NS` 必须与 client 侧**逐字相同**。
验收：`~/.dsh/settings.yaml` 出现 `dsh-codegraph:` 段。
依赖：W0.3

**W6.2 `lib/client.js`**
产出：`lib/client.js`
内容：`window.__ModuleLoader__.load({id:'dsh-codegraph', factory})`；`factory` 里 `require('react')` 用 `React.createElement` 手写，**不引入 JSX/构建**。注册骨架逐字对照 1.5 里那段（`settingsScope` → `settings.attach(binder.bind({namespace:NS}))` → `slots.register({name:'settings.plugin.item', key:NS, …})`）。**不 require `@deepseek-ai/dsh-client-ui-primitives`**（D2），只用 `react`。
验收：卡片出现在「插件配置」标签页；格式写错时是"卡片不出现"而非报错——所以先只放一个开关验证 dispatch 成功，再加另两个。
依赖：W6.1

**W6.3 三开关**
产出：`lib/client.js`
内容：`guide`（switch）、`frontload`（switch）、`surface`（core/full 二选一）。**不放状态行**（ADR-0006），不放可执行路径与超时。
验收：三个开关可存、可重置、可丢弃；`surface: full` 后模型能看到 10 个工具。
依赖：W6.2

### G7 full 面（对应 P6）

**W7.1 `[取证]` 8 个命令的参数面**
内容：逐个 `--help` 采集 `node`/`query`/`callers`/`callees`/`impact`/`affected`/`files`/`status` 的真实 flag，再注册。
验收：每个工具一次真实调用。
依赖：G2

### G8 迁移与收尾（对应 P7）

**W8.1 README 完整化**
内容：安装、三个开关、Model Experience（按 `dsh-write-plugin` skill 的 H4 结构写）、已知限制、**从 MCP 接入迁移的说明**。
验收：新用户能独立完成安装、迁移与排障。
依赖：全部

**W8.2 处理 `~/.dsh/AGENTS.md` 冲突**
内容：D4——改写 45–81 行那段手写铁律，删掉"不要问用户直接 init"，并把工具名对齐到本插件，避免与 B1 互相打脸。同时按 ADR-0005 说明"审批门禁是有意偏离"。
验收：全局 AGENTS.md 与插件提示词不冲突；移除 `mcp-codegraph` 行后 codegraph 能力仍可用。
依赖：G2、G4

### G9 测试 harness（贯穿）

**W9.1 `test/run-plugin-test.mjs`**
产出：`test/run-plugin-test.mjs`
内容：自带 fixture——脚本自己 `mkdtemp` 建 2–3 个源文件的小项目并跑真实 `codegraph init -y`（-y 见 1.3），断言 `explore` 返回里**包含 fixture 里的符号名**（内容断言，不是"没抛错"）。跨平台：不依赖 `which`、不依赖 `/bin/bash`。
验收：在 Windows 与 POSIX 上都是绿的；仓库外不留手工 fixture。
依赖：G0

**W9.2 桩 ctx**
内容：只实现 `tools.register` / `tools.get` / `systemPrompt.section` / `systemPrompt.getSectionOrder` / `on` / `get` / `settings.register`。
验收：不需要真 dsh 进程即可测契约。
依赖：W9.1

**W9.3 结构性契约断言**
内容：`core` 面恰好 2 个工具、`full` 面 10 个；B1 section 的 order 小于 `TOOL_READ` 的 order；`guide: false` 不注册 section；`frontload: false` 不注册监听器；`timeoutMs` 全部为正（D5）。
验收：任一条被改坏时测试变红（**先故意改坏一次确认它真的会红**）。
依赖：W9.2

**W9.4 Windows 分支单测**
内容：构造 `C:\…\codegraph.cmd`，断言 argv 未被直接交给 `spawn`，而是走了 shim 或 `node.exe + entry`。
验收：见 W1.2。
依赖：W1.2、W9.2

**W9.5 B2 用例**
内容：结构性中文 prompt 注入；非结构性静默；同文重发不重复；未索引静默；`prompt-hook` 连续失败后熔断；默认决策里的 runtime-context 快照未被吃掉（D3）。
验收：六条各自独立可红。
依赖：G5、W9.2

---

## 4. 契约冻结（签名，先钉死再写码）

```js
// lib/index.js —— 具名导出，无 default
export const name = 'codegraph'
export const inject = ['tools', 'systemPrompt']
export const Config = z.object({
  guide: z.boolean().default(true),
  frontload: z.boolean().default(true),
  surface: z.union([z.const('core'), z.const('full')]).default('core'),
  autoSync: z.boolean().default(true),
  executable: z.string().default('codegraph'),
  exploreTimeoutMs: z.number().default(120000),
  indexTimeoutMs: z.number().default(900000),
})
export function apply(ctx, config) { /* … */ }
```

```js
// lib/runner.js —— 内部面
export async function resolveCommand({ ctx, config, exec, path })
  // → { kind: 'shim'|'bundle'|'path'|'local', argv0, args0 }  （每次调用重读）
export function buildInvocation(resolved, args)   // → [argv0, ...argv] | throws
export async function runCodegraph(args, { cwd, signal, timeoutMs })
  // → string（stdout）；exit≠0 时 throw（stderr → stdout → exit+cmdline）
export function resolveRoot(exec, explicitPath)   // 缺 cwd 且无 path → throw
```

```js
// 工具注册（core 面）
defineTool({
  name: 'codegraph_explore',
  parameters: { query: …, path: …, maxFiles: … },
  timeoutMs: config.exploreTimeoutMs,        // 必填：seam 没有 timeoutMs（风险 3）
  execute: async (args, exec) => {…},
})
defineTool({
  name: 'codegraph_index',
  parameters: { operation: 'init'|'sync'|'index', path: …, force: … },
  timeoutMs: config.indexTimeoutMs,
  execute: async (args, exec) => {…},        // init 追加 -y；init 不接受 --force
})
```

```js
// B1
ctx.systemPrompt.section({ name: 'tool:codegraph', order, text: CODEGRAPH_GUIDE })
// order: try { getSectionOrder('TOOL_BASH') - 10 } catch { 990 }

// B2
ctx.on('agent/pre-step', async (payload, next) => {
  const decision = await next()                    // { kind:'enter', messages:[...claimed, context] }
  if (!hasNewUserMessage(payload.messages)) return decision
  const injected = await promptHook(...)           // 3s 硬超时；失败/空闲返回 null
  if (injected === null) return decision
  return { ...decision, messages: [...decision.messages, injected] }   // 追加，不替换（D3）
})

// 审批
ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name === 'codegraph_index' && ['init','index'].includes(exec.arguments.operation))
    return { kind: 'ask', reason: '…' }
  return next()
})

// settings（NS 是 host 与浏览器半边唯一的 join key）
ctx.settings.register('dsh-codegraph', Schema)
```

---

## 5. 验证

**分层**（对应 `dsh-test-plugin` skill 的取舍原则——只跑覆盖改动面的最小集合）：

| 层 | 何时跑 | 本项目的形态 |
|---|---|---|
| 契约单测 | 每次改 `lib/*.js` | 桩 ctx（W9.2），断言结构契约与 Windows 分支（W9.3、W9.4、W9.5） |
| 运行时 harness | 改 runner / 工具面 / B2 后 | `test/run-plugin-test.mjs`，自带 `mkdtemp` fixture + 真实 `codegraph init -y`（W9.1） |
| 真实组合 | 每个阶段收口 | 装进 `web` profile，真起 dsh，走一遍 §0 的第 2–4 条 |
| 人工端到端 | 一次（P2/P4/P5 各收口时） | PLAN §4 的四条场景 |

**每阶段的最小验收动作：**

| 阶段 | 命令 / 动作 |
|---|---|
| P0 | `dsh plugin --profile web add …` → `dsh --profile web --dump-default-config` 里出现本插件行；启动无报错 |
| P1 | 新会话问一句"探索代码结构先用什么"，模型答 codegraph_explore |
| P2 | Windows 上 `explore` 返回真实源码；`autoSync:false` 后行为退化但可用 |
| P3 | `init` 弹审批；拒绝后 `.codegraph/` 不产生 |
| P4 | 结构性中文 prompt 注入；同文重发不重复；超时 3 s 放弃 |
| P5 | 设置页出现卡片；值落 `~/.dsh/settings.yaml`；重载后回显 |
| P6 | 每个 full 工具一次真实调用 |
| P7 | 按 README 从零走一遍安装与迁移 |

---

## 6. 风险 → 工作项

PLAN §5 的 13 条风险全部落到了具体工作项；本计划新增 6 条。

| # | 风险 | 落到 |
|---|---|---|
| 1 | Windows spawn `.cmd` = EINVAL | W1.2、W9.4 |
| 2 | 镜像跳过平台包 | W1.1 的多级回退 |
| 3 | seam 无 `timeoutMs` | W2.1/W2.2 显式声明、W9.3 断言 |
| 4 | `getSectionOrder` 名字漂移 | W3.2 try/catch + 常量 |
| 5 | 新符号静默不可见 | W2.3 |
| 6 | `prompt-hook` 是 hidden 命令 | W5.4 熔断（1.4 已确认命令存在） |
| 7 | B2 在用户 prompt 路径起进程 | W5.3 硬超时 3 s |
| 8 | B2 重复注入 | W5.2 |
| 9 | 手写 client bundle 格式漂移 | W6.2 逐字对照 `dsh-context`，先单开关验证 |
| 10 | 自动 sync 大仓到秒级 | W2.3 + `autoSync` 开关 |
| 11 | 自动 sync 写操作在只读项目失败 | W2.3 降级 + 陈旧标注 |
| 12 | shim 的 `stdio:'inherit'` 依赖 | W1.3 `[取证]` 探测 |
| 13 | 自动 sync 与官方口径冲突 | W4.1 审批 + W8.2 文档 |
| **D1** | 解析链找不到本机已装的运行时 | W1.1（加第四级）、W1.2 |
| **D2** | `client-ui-primitives` 不是真包 | W0.1、W6.2 |
| **D3** | B2 覆盖默认决策的 runtime-context | W5.1、W9.5 |
| **D4** | 全局 AGENTS.md 与审批门禁冲突 | W8.2 |
| **D5** | `timeoutMs` 非正数导致启动崩溃 | W0.3、W2.1、W9.3 |
| **D6** | peer 在 profile 里解析不到 | W0.1 |
| **D7** | `init` 不带 `-y` 会挂到 900 s | W2.2、W9.1 |
| **D8** | `explore` 不继承 cwd，需显式 `-p` | W2.1、W2.0 |

---

## 7. 顺序

写码顺序（`→` 表示必须先于）：

```
W0.1 W0.2 → W0.3 → W0.4 → W0.5 ─────────────────┐
                                        │        │
                        G3 (B1) ────────┘        │
                                                 ↓
                    W1.1 → W1.2 → W1.3 → W1.4 → W2.2 → W2.0 → W2.1 → W2.3 → W2.4
                                     │                    │
                                     ↓                    ↓
                                   W4.1 → W4.2      W5.1 → W5.2 → W5.3 → W5.4
                                                          │
                                                        W6.1 → W6.2 → W6.3
                                                          │
                                                     W7.1 → W8.1 → W8.2
```

三条并行线，收口点只有三个：**P2 收口**（W1.4 完成即有可用的 `explore`）、**P3 收口**（审批到位才敢开自动 sync 的默认值）、**P5 收口**（卡片出现）。W9.x 贯穿全程，每完成一个 G 就补对应的断言——不要留到最后一起写测试。

**先做的三件事**（其余都可延后）：

1. **W0.1 + W0.5**：先把包装进 profile，确认 patch 层生效。这一步能提前暴露 D6（peer 解析）与 D2（primitives），而这两个都是"装不上"级别的问题。
2. **W1.1 + W1.2**：解析链与调用形式。D1/D7/D8 三个坑全在这里，且这是所有工具的地基。
3. **W2.2 的 `init -y` 验证**：确认无 TTY 下不挂。挂的话整条自举路径都要换方案，越早知道越好。
