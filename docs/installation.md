# 安装与升级插件

本文说明如何从本仓库安装、升级和卸载插件，以及如何验证安装结果。适用于所有插件；具体插件的包名、版本、依赖和兼容范围以各插件目录下的 `README.md` 与 `package.json` 为准。

## 环境要求

- Node.js：满足插件 `engines.node`；当前 bookshelf 要求 `^22.19.0 || >=24.0.0`。
- pnpm：本仓库使用 pnpm workspace，根目录 `package.json` 声明了 `packageManager`。
- DSH CLI：满足插件 `engines.dsh`；当前 bookshelf 要求 `>=0.2.1-rc.2 <0.3.0`，已在 `0.2.1-rc.5` 验证。
- DSH profile：安装位置是某个 profile（例如随附的 `web`）；插件不会安装到 DSH 安装目录本身。

## 从 checkout 安装（开发/本地使用）

在仓库根目录执行：

```sh
pnpm install
pnpm run build
```

`build` 会在各插件的 `lib/` 下生成发布入口；`lib/` 被 `.gitignore` 排除，所以新 checkout 必须先构建。然后安装到目标 profile：

```sh
dsh plugin --profile web add "$PWD/plugins/bookshelf"
```

这条命令把当前 checkout 以链接方式加入 profile 的 `package.json` 和 `dsh.profile.bundles`。链接安装不会自动执行构建，更新源码后需要重新执行 `pnpm run build`。

如果不想链接到源码目录，也可以先打包再安装：

```sh
mkdir -p dist
pnpm --filter dsh-bookshelf pack --pack-destination "$PWD/dist"
dsh plugin --profile web add "$PWD/dist/dsh-bookshelf-0.1.0.tgz"
```

`dist/` 默认被 `.gitignore` 排除；实际文件名以 `pnpm pack` 输出为准。

## 从 npm 安装（发布后）

插件发布到 npm 后：

```sh
dsh plugin --profile web add dsh-bookshelf
```

DSH 会检查插件声明的 `engines.dsh`；不满足当前运行版本时会拒绝安装或启动，除非用户显式确认版本豁免。

## 安装到其他 profile

把 `web` 换成目标 profile 名称即可。创建新的 Web profile：

```sh
dsh --profile my-profile --from-default-profile web --dump-config
dsh plugin --profile my-profile add "$PWD/plugins/bookshelf"
```

`--from-default-profile` 会用随附模板替换目标 profile；上面的命令用于新建 profile，已有自定义配置的 profile 不要用它重建。

`dsh plugin` 首次使用时会初始化 profile，并按需把插件加入 `dsh.profile.bundles`。不要把插件装到 DSH 的全局安装目录，也不要在插件目录中另建独立锁文件。

## 验证安装

不启动服务，先检查组合配置：

```sh
dsh --profile web --dump-config | grep -A2 'dsh-bookshelf'
```

输出中应出现类似：

```yaml
# == dsh-bookshelf
- id: bookshelf
  name: dsh-bookshelf
```

启动 `dsh web` 后，在页面中应能看到插件的入口。启用 HMR 的 profile（`patchReload: live`）会在 profile 变更后重载；没有启用 HMR 的 profile 需要重启 `dsh web`。

安装后检查运行数据目录：

```sh
ls "${DSH_HOME:-$HOME/.dsh}/bookshelf" 2>/dev/null || true
```

bookshelf 的记录文件是 `$DSH_HOME/bookshelf/library.json`（默认 `~/.dsh/bookshelf/library.json`），首次添加书籍时创建。

当前 bookshelf 按 `DSH_HOME` 保存一套书架，不按 profile 名称分库。不同 profile 使用同一个 `DSH_HOME` 时会读取同一套记录；隔离测试应使用独立的 `DSH_HOME`，不要让多个进程同时写入同一套书架。

## 升级

### 链接安装

```sh
pnpm install
pnpm run build
```

然后刷新已打开的 DSH 页面。profile 没有 HMR 或插件没有自动重载时，重启 `dsh web`。如果插件包版本发生变化，重新执行 `dsh plugin --profile web add "$PWD/plugins/bookshelf"` 让 profile 记录新的依赖。

### tarball 或 npm 安装

先卸载旧包，再安装新包：

```sh
dsh plugin --profile web remove dsh-bookshelf
dsh plugin --profile web add "$PWD/dist/dsh-bookshelf-0.1.0.tgz"
```

全新安装前确认 `lib/` 已由 `pnpm run build` 生成。不要直接覆盖 profile 的 `package.json` 或 `node_modules`。

## 卸载

```sh
dsh plugin --profile web remove dsh-bookshelf
```

卸载会从 profile 依赖和组合包列表中移除插件，但不会删除：

- 用户的书架记录：`$DSH_HOME/bookshelf/library.json`
- 原书文件

需要彻底清除数据时，先确认路径，再手动删除书架记录文件；这不会影响原书文件。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动提示找不到 `lib/index.js` 或 `lib/client.js` | checkout 未构建，或构建产物被清理 | 在仓库根目录执行 `pnpm run build`，确认插件 `lib/` 存在 |
| `dsh plugin add` 后页面没有入口 | profile 未重载或没有 HMR | 刷新页面；仍无入口时重启 `dsh web` |
| 安装被拒绝，提示 DSH 版本不兼容 | 插件 `engines.dsh` 不匹配 | 升级/切换 DSH，或按插件文档确认支持的版本范围 |
| 安装后数据为空 | 使用了不同的 `DSH_HOME`，或该数据目录尚未添加书籍 | 核对 `DSH_HOME` 与书架底部显示的记录路径；仅切换 profile 不会自动分库 |
| `pnpm` 构建失败 | Node.js/pnpm 版本不满足，或依赖未安装 | 核对 README 的环境要求，执行 `pnpm install` 后重试 |
| 插件升级后仍是旧代码 | 链接安装可直接复用源码，但未重新构建 | 执行 `pnpm run build`，再刷新或重启 |

## 数据与文件边界

- 插件记录保存在 `$DSH_HOME`，不进入源码仓库或发布 tarball。
- 原书文件由用户保存在任意位置；插件只读访问，不复制、不修改、不移动、不删除。
- 测试和演示用的书籍不要提交到仓库；使用临时目录或可公开样例。
