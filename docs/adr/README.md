# 架构决策记录（ADR）

本目录记录 `@mrbbbaixue/dsh-codegraph` 的关键决策及其理由。每条 ADR 都带**备选方案**和**后果**，改主意时先读对应 ADR，不要只改代码。

| 编号 | 标题 | 一句话 |
|---|---|---|
| [ADR-0001](ADR-0001-cli-over-mcp.md) | 用 CLI 子进程替换 MCP 接入 | 三路线实测对比；MCP 的 `initialize.instructions` 被 dsh 客户端丢弃是本项目立项理由。**接入形态已被 [ADR-0007](ADR-0007-resident-mcp-session.md) 覆盖** |
| [ADR-0002](ADR-0002-codegraph-runtime-provisioning.md) | codegraph 运行时的获取方式 | 声明 npm 依赖 + 解析回退链；磁盘开销省不掉 |
| [ADR-0003](ADR-0003-two-layer-prompt-injection.md) | 两层提示词注入（B1 + B2） | B1 走 `systemPrompt.section`；B2 走 `agent/pre-step`（`PromptContext` 用不了）。B1 文案已换成官方全文，通道决策不变 |
| [ADR-0004](ADR-0004-tool-surface-explore-and-index.md) | 工具面收敛到 explore + index | 官方实测背书"一个强工具胜过一菜单窄工具"；`index` 是有意偏离 |
| [ADR-0005](ADR-0005-index-lifecycle.md) | 索引生命周期 | 查询前自动 `sync`；未索引时自动 `init`（文件数上限默认 1 万）；工具发起的 `init`/`index` 走审批。**自动 `sync` 已降级为 CLI 回退路径补偿，见 [ADR-0007](ADR-0007-resident-mcp-session.md)** |
| [ADR-0006](ADR-0006-plugin-shape-and-settings-card.md) | 插件形态、包名与设置卡片 | `@mrbbbaixue/dsh-codegraph`；零构建；手写 client bundle；一张面板承载全部设置（无状态行，无保存按钮）。字段数已增至 10（见 [ADR-0007](ADR-0007-resident-mcp-session.md)） |
| [ADR-0007](ADR-0007-resident-mcp-session.md) | 常驻 MCP 会话 | 每项目一条常驻 `serve --mcp` 会话替代每次 spawn；索引交给 daemon 的 watcher，查询前不再 `sync`；B1 换成官方全文 |

术语先查 [术语表](../glossary.md)。阶段与架构见 [PLAN.md](../../PLAN.md)，逐文件的编写顺序见 [编写计划](../IMPL-PLAN.md)。
