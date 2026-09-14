# ADR-0006：插件形态、包名与设置卡片

- 状态：已接受
- 日期：2026-09-14
- 修订：2026-09-15（见文末「修订记录」）

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

## 修订记录

### 2026-09-15：面板成形，全部字段上卡片

**起因**：用户反馈「设置散落在外面」——卡片上是散装的一行行控件而不是设置页其它插件那样的卡片，
且 `autoSync` / `executable` / 两个超时只能靠改 `cordis.patch.yml` 才能看见和改。

**改了什么**（本节覆盖上文与之冲突的部分）：

- **卡片改成真正的面板**：一个 `<li>`，标题行（名称 + 一句话说明 + chevron）负责开合，面板内按「行为 /
  高级」分段排列控件，底部是「全部恢复默认 / 放弃修改 / 保存」。样式用主题变量复刻设置页其它卡片的
  观感，仍不引入 `dsh-client-ui-primitives`（图标用一枚内联 SVG chevron）。
- **七个字段全部上卡片**：上表的三项之外，`autoSync`、`executable`、`exploreTimeoutMs`、
  `indexTimeoutMs` 也进面板。它们仍然是组装层可配的同一个 schema，`cordis.patch.yml` 保留为部署默认值，
  面板只是多了一条更近的写入路径（并自带「清空即撤掉覆盖」的回退手势）。
- **写入改成暂存式**：原来是每改一个控件立刻写一次。现在控件改的是草稿，保存时以**一次** mutation 提交，
  并带上读取草稿时的 revision——期间别处改过设置就整批拒绝，而不是静默覆盖。数值草稿不是正整数毫秒时
  保存被挡住，不把注定被 Host 校验拒绝的值发出去。

**没变的部分**（上文仍然有效）：包名、零构建手写 client bundle、host 与 browser 以 settings namespace
为 join key、**不放索引状态行**——理由（卡片拿不到会话/工作区上下文）与本决定无关，依然成立。

**新增的负面**：面板仍是手写 bundle，面板内部结构（字段表、样式、控件）只由 `test/run-plugin-test.mjs`
里的客户端断言守着；格式契约漂移依旧是「静默不出现」而不是报错。此外，面板写的是**全局** settings
namespace，所以 `executable` 这类本质属于部署的值进了用户层——同一台机器上多 profile 共用一份
`~/.dsh/settings.yaml` 时，一处改动会影响所有 profile。

### 2026-09-15（续）：控件与观感对齐设置页自身

**起因**：用户要求「控件样式符合官方效果，勾选改成开关，默认收缩」。

**改了什么**：

- **改用官方原语**：`require('@deepseek-ai/dsh-client-ui-primitives')` 取 `Switch` 与
  `IconChevronDownOutline14`。这一条**推翻上文「Deliberately not used」的判断**——当时认为该包不受
  node_modules 供给，事实相反：它是浏览器模块表里的正式条目（`react`、`dsh-client-store`、
  `dsh-client-ui-slots`、`dsh-client-ui-dockkit` 与它并列），`dsh-context` 也正从那里取 `Menu` 与图标。
  勾选框因此变成官方的 `role="switch"`，与设置页其它卡片完全同形。
- **控件度量对齐**：字段行、label、重置、输入框、hint、页脚按钮的尺寸与颜色改用
  `dsh-client-ui-settings-plugins` 自己的 `fields.module.css` / `PluginCard.module.css` 度量，只是换了
  本插件前缀。文本与数值字段改为**标签一行、控件整行在下方**（官方 `ValueField` 的版式），
  `surface` 与开关才与标签同行。
- **默认收缩**：`open` 初值为 `false`，与设置页其它卡片一致。
- **去掉分段标题与「全部恢复默认」**：官方卡片里没有分组标题，重置是**每个字段**右上的一个文字按钮，
  只在用户层带该字段时出现。面板照做，`unset` 单字段的工具函数因此与手动清空再保存等价。
- **打开态可测**：面板接受一个可选的 `defaultOpen`，只为让渲染型测试够得到展开后的主体；设置页传空
  props，仍是收缩态。
- **标题写作 `Codegraph`**：设置页上显示的是这张面板的名字，用户指定用这个词形，与正文、文案与文档里的
  `CodeGraph` 有意不同。

**没变的部分**：包名、零构建、namespace join key、暂存式写入与 revision 栅、不放状态行。

### 2026-09-15（再续）：去掉保存按钮，改动即写入

**起因**：用户要求面板不要保存按钮，控件一改就保存。

**改了什么**：

- **删掉页脚**：保存与放弃修改两个按钮，连同 `.codegraph-foot` / `.codegraph-discard` /
  `.codegraph-save` 三条样式一起去掉；「保存失败」改为面板末尾的一行说明。
- **写入即时化**：开关与下拉在 `onChange` 里直接写；文本框与数字框留一份草稿只用于显示，停手 400ms
  落盘，失焦与面板卸载时立刻落盘。清空文本仍等于 `unset`，数字草稿不是正整数毫秒时不写出去。
- **不再用 `mutate`**：原来是攒够一批 op 再带 revision 提交。现在每个字段一次 `scope.set` /
  `scope.unset`——官方契约写明这类写入「保留顺序、各自带最新 revision、只有最新一次结算可发布」，
  所以连续快改按序落盘，也不会拿过期 revision 去顶掉别处的改动。

**没变的部分**：包名、零构建、namespace join key、不放状态行。

**新增的负面**：没有暂存也就没有撤销入口，写错的路径或超时值会立刻落到 `~/.dsh/settings.yaml`，
改回去只能重新编辑，或按该字段的「重置」撤掉这条覆盖。

### 2026-09-15（三续）：面板再加两个字段

**起因**：未索引的工作区改为自动建索引（ADR-0005 修订），它的两个旋钮要能在面板上改。

**改了什么**：

- `FIELDS` 增加 `autoIndex`（开关，默认开）与 `autoIndexMaxFiles`（数字框，默认 10000），面板共 9 个字段。
- 数字框的非法草稿文案按字段取：毫秒字段说「需为正整数毫秒」，文件数字段说「需为正整数」——原来那句
  是写死的。

**没变的部分**：包名、零构建、namespace join key、即改即写（无保存按钮）、不放状态行、字段总数（仍是 9 个）。

### 2026-09-15（四续）：超时改用秒，数字框带上单位

**起因**：面板上 `explore 超时（毫秒） / 120000 / 单次 explore 调用的上限，默认 120000` 这一行既难读也难改。

**改了什么**：

- **两个超时的单位从毫秒改成秒**：`exploreTimeoutMs` / `indexTimeoutMs` → `exploreTimeoutSec`（默认 120）/
  `indexTimeoutSec`（默认 900）。配置层只存秒，毫秒换算是 host 的事（`defineTool` 的 `timeoutMs`、
  `runCodegraph` 的 `budgetMs` 一律 ×1000）。schemastery 在非严格模式下把未知键原样保留，所以用户层里的旧
  毫秒覆盖不会让插件报错，也不会再被读取——需要在面板上重设一次。
- **数字框带单位后缀**：单位（秒 / 个文件）从 label 的括号里挪到控件右侧；输入框不再占满整行（150px）——
  给三位数配一个整行宽的框，看起来像文本框。
- **非法草稿的文案按单位分**：超时字段说「需为正整数秒」，文件数字段说「需为正整数」。

**没变的部分**：包名、零构建、namespace join key、即改即写（无保存按钮）、不放状态行、字段总数（仍是 9 个）。
