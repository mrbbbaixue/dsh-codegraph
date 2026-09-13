# ADR-0004：工具面收敛到 explore + index

- 状态：已接受
- 日期：2026-09-14

## 背景

每个可见工具的 schema 都是**每请求固定 token 成本**，这是唯一真正的取舍点。候选面从 1 个到 10 个都有人做：

- 官方 MCP：**1 个**（`codegraph_explore`）
- jiangzhenguo：core 4 个（`status`/`init`/`sync`/`explore`），full 13 个
- CC19990113：2 个（多 operation 的 `codegraph` + `codegraph_index`）

## 决策

**默认面（`surface: 'core'`）= `codegraph_explore` + `codegraph_index`。**

**`surface: 'full'`** 在此基础上**追加**其余 8 个：`node`、`query`、`callers`、`callees`、`impact`、`affected`、`files`、`status`。即 `full` ⊇ `core`，不是替换关系。

`codegraph_index` 的 `operation` 有三个值：`init`（首次建索引）、`sync`（增量）、`index`（全量重建）。

## 理由

官方 README 的 `## MCP Tools` 一节给了**实测背书**的结论，原文：

> When running as an MCP server, CodeGraph exposes a **single tool** — `codegraph_explore`. **Measured agent behavior showed that one strong tool steers agents better than a menu of narrower ones — fewer mis-picks, and it saves context every session.**
>
> The other tools (`codegraph_node`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_files`, `codegraph_status`) stay fully functional but **unlisted by default** — **everything they return already arrives inline on `codegraph_explore`** (its blast-radius section, the relationship map, a symbol's body as its callee list).

注意它连 `codegraph_status` 都划进"多余"那一档。`docs/benchmarks/call-sequence-analysis.md` 里记着 "SHIP: the CODEGRAPH_MCP_TOOLS allowlist — independent, clean, validated"。

这条证据推翻了一个更早的 4 工具方案（`status`/`explore`/`node`/`index`）：`node` 的返回值 `explore` 已经内联带着（caller/callee trail、dependents），`status` 也一样——`explore` 在未索引时返回的原文就是 `CodeGraph isn't available here — no .codegraph/ index exists in <path>...`，模型一看就知道。

**唯一有意偏离官方的是 `index`**：官方 MCP 面刻意不给自举能力（README 原文 "indexing stays your decision"），而本插件的立项诉求正是"装插件就把 codegraph 带起来"。这个偏离是需求的直接结果，不是对官方结论的无视。

## 后果

**正面**：默认只有 2 个 schema；模型的工具选择面与官方实测推荐一致；`full` 面保留了想要窄工具的部署。

**负面**：

- `codegraph_index` 是本插件**自己造的工具名**，官方 MCP 面没有对应物，B1 文案里必须解释它的三个 operation。
- `full` 面按官方说法会 induce mis-picks，所以它只能是显式选择的开关，不能是默认。

## 补充：dsh 与 MCP 在"unlisted"上的语义差异

官方说 unlisted 的工具 "stay fully functional"，是指 MCP 服务端仍定义着它们，支持 tool search 的客户端能按名加载（`codegraph_explore` 的描述里写着 "If it's listed but deferred, load it by name via tool search"）。

**dsh 没有 deferred tool 这层**：`ctx.tools` 注册表投影给模型的就是最终 schema 集合，`ctx.tools.restrict()` 也只是缩小可见集合。所以在本插件里，不给 schema 等于**彻底不可用**，不存在"MCP 那种列出来但延迟加载"的中间态。`surface` 开关的含义因此比官方语境更硬。

## 备选方案

- **只给 `explore`**：最省 token、最贴官方，但没有自举路径，与立项诉求直接冲突。
- **全部 10 个**：官方明确反对。
- **把 `index` 拆成 `init` + `sync` 两个工具**（jiangzhenguo 的做法）：多一个 schema，而 operation 参数足以区分。
