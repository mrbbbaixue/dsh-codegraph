# ADR-0003：两层提示词注入（B1 静态 + B2 动态）

- 状态：已接受
- 日期：2026-09-14
- 需求来源：用户要求"codegraph 的提示词要做成提示词注入的形式"

## 背景

codegraph 官方给 agent 的提示词有现成素材，都是静态常量：

| 素材 | 位置 | 体积 |
|---|---|---|
| `SERVER_INSTRUCTIONS` | MCP `initialize` 返回 | ~4.5 KB |
| `SERVER_INSTRUCTIONS_NO_ROOT_INDEX` | 同上，无根索引变体 | ~1 KB |
| `CODEGRAPH_INSTRUCTIONS_BLOCK` | installer 写进 `CLAUDE.md`/`AGENTS.md` 的 marker 块 | ~0.9 KB |

但 dsh 的 MCP 客户端把 `initialize.instructions` 整个丢弃了（ADR-0001），所以这些文本从来没进过模型上下文。用户全局 `~/.dsh/AGENTS.md` 里那段 codegraph 指引是纯手工维护的。

官方还有一个**动态**机制：`codegraph prompt-hook`（Claude Code 的 `UserPromptSubmit` hook）。stdin 收 `{prompt, cwd}`，对结构性 prompt 跑一次 `explore`，把结果用 `<codegraph_context>` 块打到 stdout。契约是"任何失败路径都 exit 0 且无输出"，注入上限 9000 字符，门控分三级（HIGH 关键词/已验证 token → 全量注入；MEDIUM 散文词命中符号名分段 → 只列符号名；silent → 无操作）。

## 决策

**B1（静态）**：`ctx.systemPrompt.section({ name: 'tool:codegraph', order, text })`，文案以官方 `SERVER_INSTRUCTIONS` 为底本裁剪到约 1.5 KB，工具名映射到本插件的 `codegraph_explore` / `codegraph_index`。

- `order` 取 `ctx.systemPrompt.getSectionOrder('TOOL_BASH') - 10`，**不硬编码数字**。dsh 0.1.5-rc.2 的第一方 order 实测是 `TOOL_BASH:1000 / TOOL_PWSH:1010 / TOOL_READ:1100 / TOOL_WRITE:1200 / TOOL_EDIT:1300 / TOOL_GLOB:1400 / TOOL_GREP:1500`，第一方自己也是用 `getSectionOrder()` 解析的。拿不到时回退常量。
- 作用域：全局。**因此 subagent 也生效**——这正是官方 instructions block 存在的理由：官方实测"没有这块，subagent 在 9 次里只有 1 次想起用 codegraph"。

**B2（动态）**：`ctx.on('agent/pre-step')` 里 `await next()` 之后，把注入消息插进 `decision.messages`。

- 门控复用官方 `codegraph prompt-hook` 子进程，把 `{prompt, cwd}` 写进 stdin，读 stdout 的 `<codegraph_context>` 块。
- **不做启动探测**。改为按需 + 进程内熔断：首次真正需要时才 spawn，失败（ENOENT / 非零退出 / 超时）即静默跳过；同一进程内连续失败 2 次后不再尝试。不落盘、不阻塞启动。
- **硬超时 3 s**，超时直接放弃注入，绝不拖住 turn。
- 注入通道用 `agent.inject()` 语义的**位置**（插进当步消息），但**不伪造** `source: { kind: 'user' }`——用 plugin 来源，避免注入内容在 UI 与会话日志里与真人输入同源。
- 按 prompt 文本去重（每 agent 一个 Map，10 分钟过期，上限 20 条）。GUI 重发/重试会让同一条 prompt 多次进 `nextTurn`，不去重会重复注入十几 KB。

**为什么 B2 不能挂在 `dsh-system-prompt` 上**：该包的 `context()` 贡献是**同步 provider**（`text: string | ((ctx: AssembleContext) => string)`，见 `lib/types/index.d.ts:70-77`），而 `AssembleContext` 只有 `scope` 和 `signal`——拿不到当前用户 prompt，也做不了异步 explore。B2 只能在 agent 层实现。B1 则正是 `section()` 的用途。

## 理由

B1 解决"知不知道有这东西"，B2 解决"会不会真的用"。官方 installer 对 prompt-hook 是 opt-in 但 **default-yes**，理由就是 adoption：光有工具和指引，agent 仍然会先 grep。

B2 选 pre-step 改写而不是 `agent/inbox/inserted` + `agent.inject()`：B2 的全部价值在于"让模型的 grep 反射没东西可找"，这**只在第一次请求前到达才成立**。inject 是异步的，竞态会让它在慢一点的机器上落到第二个 step，那时模型已经 grep 过一轮了。多花的 300–600 ms 换掉的是几十次 grep/read 往返。

## 后果

**正面**：补回了官方 playbook 这条被 dsh 丢掉的通道；B2 复刻了官方唯一被 eval 验证过的 adoption 杠杆；全程静默失败，任何异常都不会污染用户消息。

**负面**：

- B1 每请求固定约 1.5 KB（约 400 tokens）。
- B2 命中时每轮最多 +9000 字符，且这个子进程开销落在**用户 prompt 的进入路径**上。
- B2 依赖 `codegraph prompt-hook` 这个 **hidden 命令**（官方定位 Claude Code 专有）。熔断把它限制在"B2 失效"，不影响 B1 和工具面，但上游一旦改名/删除，B2 会静默退化成无操作。

## 备选方案

- **自己实现 B2 门控**（关键词表 + 代码 token 用 `query --json -l 1` 逐个验证）：不依赖 hidden 命令，但 jiangzhenguo 那份实现没有测试背书，且高置信分支之外要在 prompt 路径上串最多 5 次 `query` 子进程，最坏比官方更慢。
- **只做 B1**：最小实现，但放弃官方已验证的 adoption 杠杆。
- **把 B1 写进用户 `~/.dsh/AGENTS.md`**：正是现状，需要手工维护、且无法随插件卸载而清理。
