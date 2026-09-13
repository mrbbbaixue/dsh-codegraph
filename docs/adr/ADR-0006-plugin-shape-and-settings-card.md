# ADR-0006：插件形态、包名与设置卡片

- 状态：已接受
- 日期：2026-09-14

## 背景

插件是发布形态（要能给别人装），且用户要求"在「插件-插件配置-CodeGraph」加开关"。后者把范围扩到了浏览器半边。

关于设置卡片，有一个必须先确认的硬事实：**宿主侧注册 settings 命名空间不够**。`dsh-client-ui-settings-plugins` 的 README 写明，配置标签页渲染的是两份账本的交集——"存活 Host 插件注册的命名空间，以及注册在这些键上的卡片"，"**被服务却无人认领的命名空间什么都不渲染**"。所以必须写 client 半边，没有只改 host 的捷径。

README 同时给了一条劝退信息："产出它的 `clientBundle` 预设位于 `packages/client/tsdown.client.ts`，**并非已发布的包**，因此本仓库之外的插件得自行复刻该构建。"

## 决策

**包名**：`@mrbbbaixue/dsh-codegraph`（带 scope，与已占用的 `dsh-codegraph`@0.1.3、`dsh-plugin-codegraph`@0.1.6 彻底无缘）。

**形态**：单包、纯 ESM JS、**无构建步骤**。host 半边就是 `lib/index.js`。

```
package.json          dsh.bundle.patch + dsh.client + peerDependencies + files
cordis.patch.yml      - insert: [{ id: dsh-codegraph, name: '@mrbbbaixue/dsh-codegraph' }]
lib/
  index.js            插件入口：Config / apply / 工具注册 / B1 / B2 / 审批
  guide.js            B1 提示词文本（单独放，便于评审与改文案）
  runner.js           codegraph 进程执行：解析链、Windows shim、超时、输出收集、错误归一
  client.js           浏览器半边：设置卡片（手写，无构建）
README.md
docs/adr/             本目录
docs/glossary.md
test/run-plugin-test.mjs
```

**client bundle 手写**，不引入 tsdown/TS 工具链。格式已经确认（`dsh-context` 的产物就是明证）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-codegraph',
  factory: (require) => {
    var module = { exports: {} }
    let react = require('react')
    let primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    // ...
    module.exports = { name: 'dsh-codegraph', inject: ['slots', 'locale'], apply }
    return module.exports
  },
})
```

用 `React.createElement` 即可，不需要 JSX。host 与浏览器半边的 **join key 是同一个 settings namespace**：host 侧 `ctx.settings.register(NS, Schema)`，client 侧 `slots.register({ name: 'settings.plugin.item', key: NS, ... })`。

**设置卡片只放 3 个开关**：

| 开关 | 控件 | 默认 |
|---|---|---|
| `guide`（B1 系统提示词注入） | switch | 开 |
| `frontload`（B2 动态前置） | switch | 开 |
| `surface`（工具面） | core / full 二选一 | `core` |

**不放状态行**：`codegraph status` 不带 `-p` 时读的是进程 cwd，而索引按项目根存放；设置卡片通过 `settingsScope` 绑定的是全局 namespace（落 `~/.dsh/settings.yaml`），**拿不到 session / workspace 上下文**。两者拼起来，卡片上那行状态显示的会是"dsh 服务进程启动目录"的索引状态，与用户当前在哪个项目干活完全无关。

**不上卡片的配置**（留在 `cordis.patch.yml` 的 config 给高级用户）：`executable`（可执行文件路径）、`exploreTimeoutMs`、`indexTimeoutMs`、`autoSync`。

（`autoSync` 属于同类可调项，但它是 ADR-0005 里明确标注了"大仓库未测"的风险逃生阀，实现时按需决定是否一起放上卡片。）

## 理由

包名带 scope 是因为三个合理的无 scope 名字已被占其一，且 scope 天然免疫重名。

无构建的理由是简洁：host 半边 600 行以内的 JS 不值得引入 tsc/tsdown 工具链；client 半边的格式对手写友好，用 `React.createElement` 写一个三开关卡片约 100 行。

不放状态行是用户直接否决的，理由已在上面用技术事实印证。

## 后果

**正面**：零构建工具链；安装即 `dsh plugin --profile <name> add @mrbbbaixue/dsh-codegraph`；三个开关覆盖了所有"想临时关掉"的场景。

**负面**：

- 手写 client bundle 意味着**格式契约靠复刻**，官方那份 tsdown 预设不可用。格式一旦漂移，卡片静默不出现（没有报错），调试成本高——需要在实现时用 `dsh-context` 的产物做对照验证。
- 浏览器半边需要 `@deepseek-ai/dsh-client-ui-primitives` 作为 peer，跨 dsh 版本的兼容性要自己声明。
- scope 包意味着用户安装时要写全名，`dsh plugin add` 的参数更长。

## 备选方案

- **无 scope 的 `dsh-codegraph-cli` / `dsh-tool-codegraph` / `dsh-codegraph-plugin`**：都可用，但用户选了 scope。
- **走官方 tsdown 预设**：预设不在已发布的包里，等于要自己复刻构建配置，比手写更重。
- **不写 client 半边，只做 host**：设置页不会出现任何东西，不满足需求。
