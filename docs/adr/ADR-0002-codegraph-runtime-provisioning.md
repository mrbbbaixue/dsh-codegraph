# ADR-0002：codegraph 运行时的获取方式

- 状态：已接受
- 日期：2026-09-14
- 需求来源：用户要求"不用系统安装 codegraph，装插件就带起来"

## 背景

npm 上的 `@colbymchenry/codegraph` 不是"一个包"，是两层：

| 层 | 内容 | 体积 |
|---|---|---|
| `@colbymchenry/codegraph`（thin） | `npm-shim.js` + `npm-sdk.js` + `.d.ts` | **0.7 MB** |
| `@colbymchenry/codegraph-<platform>-<arch>`（optionalDependency） | **自带 Node 24** + 完整 dist + wasm 语法 + 依赖 | **261–293 MB 解包** |

`npm-shim.js` 已内建三层自愈：平台包 → `~/.codegraph/bundles/<target>-<version>` 缓存 → 从 GitHub Releases 下载压缩包（约 50 MB，含 SHA256 校验、原子 rename、旧版本清理）。它还在注释里专门写了 Windows 的坑："Modern Node refuses to spawn the bundle's .cmd directly (EINVAL, the CVE-2024-27980 hardening on Node 24)"，用 `node.exe + entry` 绕开。

两个实测事实：

- `npm i @colbymchenry/codegraph` **只装了 thin 包，平台包被镜像源跳过**（正是 shim 注释里写的 npmmirror/cnpm 场景）。
- `install.ps1` 把 bundle 装在 `%LOCALAPPDATA%\codegraph\current`（macOS / Linux 是 `~/.codegraph/versions/<v>` + `current` symlink），但**不是 npm 布局**，npm shim 不认它。

关键推算：磁盘开销**省不掉**。自愈路径下载的 bundle 解压后与平台包是同一份内容，只是落在 `~/.codegraph/bundles/` 而非 profile。所以"不声明依赖"并不省空间，只是把 261 MB 换个位置、并把等待挪进会话中途。

## 决策

1. `package.json` 声明 `dependencies: { "@colbymchenry/codegraph": "^1.6.0" }`，由 pnpm 装进 profile。
2. runner 按顺序解析：**插件内依赖 → `~/.codegraph/bundles` 缓存 → PATH 上的 `codegraph`**。
3. 实际执行统一走 shim：`spawn(process.execPath, [require.resolve('@colbymchenry/codegraph/npm-shim.js'), ...args])`，让 shim 处理平台包解析、Windows `.cmd` 规避与自愈下载。

## 理由

声明 dependency 是 dsh 插件的标准形态——`dsh plugin --profile <name> add <pkg>` 本身就是转发 pnpm，依赖装进 profile 的 `node_modules`，版本锁在 lockfile，卸载插件时一起清掉。这一层比"插件自己去 PATH 上摸一个 codegraph"紧密得多。

保留回退链**不是设计选择而是必须的容错**：实测证明依赖声明不保证装到运行时（镜像跳过平台包）。没有回退，装了依赖也不一定能跑。

第三条是本次决策里最省事的一条：shim 已经把 Windows `.cmd` 规避、自愈下载、版本缓存清理都写好了（279 行，官方维护），我们不需要重写任何一行。

## 后果

**正面**：新用户装完插件即可离线使用（镜像正常时）；镜像异常时自动退化成下载，不会静默失败；已有 `install.ps1` 版本的用户不再重复下载。

**负面**：

- profile 可能多出 261 MB。
- shim 的子进程用 `spawnSync(..., { stdio: 'inherit' })`，继承的正是我们在 subprocess seam 里设的管道，所以 stdout/stderr 仍能分别收集、退出码正确传递——但这条依赖 shim 的实现细节，上游改成管道重定向就会失效，需要在 runner 里加断言。
- 首次云端自愈下载发生在**工具调用中途**（可能几十秒），需要有面向模型的进度提示。

## 备选方案

- **只声明 thin 包、把运行时获取全交给自愈下载**：profile 只多 0.7 MB，但磁盘上仍会多 ~250 MB（落在 `~/.codegraph`），且首次可用性从"装完即可"退化成"首次调用时下载"。
- **不声明任何依赖，纯 PATH + 缓存探测**：与 dsh 的依赖管理脱钩，版本不可控，卸载不清理。
- **把 `install.ps1` / `install.sh` 的逻辑内嵌进插件**：重复实现官方已有的 279 行自愈逻辑。
