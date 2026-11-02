# dsh-autoconfig

[![GitHub](https://img.shields.io/badge/GitHub-liuxin4566--web%2Fdsh--autoconfig-181717?logo=github)](https://github.com/liuxin4566-web/dsh-autoconfig)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490)](https://github.com/topics/dsh-plugin)

给 DSH（DeepSeek Harness）用的网络设备自动配置终端插件。基于 [dsh-ssh-ops](https://github.com/caoyiwei850/dsh-ssh-ops) 的「主对话驱动 + 右侧终端」架构重新实现，面向路由器、交换机、防火墙等设备的日常配置与排障。

## 功能

- **右侧终端面板**：在官方右侧边栏注册「自动配置终端」标签页。AI 的每一次连接、输入、读取和 SFTP 操作都会显示在同一个终端里，操作者可以全程审计。
- **四种接入方式**
  - `ssh`：ssh2 交互式 shell（PTY），支持密码 / 私钥 / keyboard-interactive，支持旧设备 SHA-1 group14 KEX 回退。
  - `telnet`：原始 TCP + RFC 854 选项协商（ECHO/SGA/TTYPE/NAWS），可自动回答 `login:` / `Password:`。
  - `console`：串口（COMx / `/dev/ttyUSBx`），默认 9600 8N1，可自动登录。
  - `sftp`：SSH 认证后只打开 SFTP 子系统；SSH 连接也可以随时切到「文件」页做 SFTP 操作。
- **自动会话日志**：连接建立即开始记录，文件名形如
  `SW-Core_10.1.1.1_20261027-231530.log`
  （`<hostname>_<ip>_<YYYYMMDD-HHmmss>.log`）。设备提示符中识别到真实 hostname 后会自动重命名日志；未填写设备名时先用 `device` 占位（如 `device_10.1.1.1_...log`），识别后再重命名。同目录下有同名 `.json` 元数据。
- **AI 工具**：`device_connect` / `device_list` / `device_send` / `device_read` / `device_close` / `device_sftp` / `device_logs`。`device_send` 会在右侧终端留下 `[agent ...]` 标记并写入日志的 `INPUT (agent)` 记录。
- **左侧会话栏**：像 MobaXterm / SecureCRT 一样保存连接过的设备。双击有锁标记（已保存密码）的会话直接重连；没有密码的会话会预填地址，只补密码即可。密码写入 DSH 凭据库，`autoconfig-profiles.json` 只保存地址、用户名和端口。
- **关键字高亮**：内置 `colorful-network.ini` 的 22 条规则（`no/down/error` 红、`up/connected` 绿、协议/端口蓝、路由/ACL 品红、接口/IP/百分比橙），大小写不敏感，按最长匹配避免重叠，且只在整词边界命中（不会把 `Usage` 里的 `ge`、`Canonical` 里的 `no` 染色）。工具栏「高亮」可随时关闭；已带 ANSI 颜色的设备输出原样保留。
- **终端外观**：终端页面默认**纯黑背景**；工具栏可一键切黑/深蓝黑/浅色，或用取色器选任意颜色。背景与高亮开关保存在浏览器 `localStorage`（`dsh-autoconfig.terminal-background` / `dsh-autoconfig.keyword-highlight`）。
- **日志查看**：面板「日志」按钮可预览、下载、删除日志；日志目录默认 `~/.dsh/autoconfig-logs`。

## 安装

### 方式一：npm（发布后）

```powershell
dsh plugin --profile desktop add dsh-autoconfig
# 或 dsh plugin --profile web add dsh-autoconfig
```

也可以直接从 GitHub 安装：

```powershell
dsh plugin --profile desktop add git+https://github.com/liuxin4566-web/dsh-autoconfig.git
```

### 方式二：本地 tgz（当前开发版推荐）

```powershell
# 在插件源码目录构建并打包
pnpm install
pnpm pack

# 安装到 desktop profile（DSH Desktop 使用的 profile 名）
dsh plugin --profile desktop add .\dsh-autoconfig-0.1.2.tgz
```

若 `dsh` 不在 PATH，请使用 DSH 安装目录中的 `dsh`/`dsh.cmd`，或通过官方 npm 包执行：

```powershell
npx @deepseek-ai/dsh plugin --profile desktop add .\dsh-autoconfig-0.1.2.tgz
```

`dsh plugin add` 会把包加入 profile 依赖，并自动把声明了 `dsh.bundle` 的包加入 `dsh.profile.bundles`。当前 DSH 桌面版是 live profile，通常会热加载；若没有出现标签页，完全退出并重启 DSH Desktop。

> SSH/SFTP 使用的 `ssh2` 已内联进宿主产物（MIT），因此不依赖 profile 对 `ssh2` 的模块解析；只有串口需要的 `serialport` 是运行时依赖。若 profile 暂时无法访问 npm，可先复制 `lib`、`locale`、`package.json`、`cordis.patch.yml` 到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-autoconfig`，并把 `dsh-autoconfig` 加入 profile 的 `dependencies` 与 `dsh.profile.bundles`（串口功能仍需 `serialport` 及其预编译绑定）。

### 串口依赖

`serialport` 带原生预编译绑定。若 profile 的 pnpm 拦截了构建脚本，需要允许：

```yaml
# ~/.dsh/profiles/desktop/pnpm-workspace.yaml
allowBuilds:
  '@serialport/bindings-cpp@13.0.0': true
```

然后重新执行安装命令。SSH/Telnet/SFTP 不依赖串口绑定，即使 `serialport` 不可用也可正常使用。

## 使用

1. 打开右侧边栏，选择「自动配置终端」标签页（或点「+ 连接」）。
2. 选择 SSH / Telnet / 串口 / SFTP，填写地址和凭据。
3. 在终端里直接操作；也可以回到对话让 AI 操作：

```text
连接 10.1.1.1 的 SSH，用户名 admin，密码 ...，设备名 core-sw-1
```

AI 会调用 `device_connect`，随后用 `device_send` / `device_read` 执行和读取命令。右侧终端会同步显示 AI 的每条输入与设备输出，日志自动落盘。

## 日志格式

```text
==============================================================================
dsh-autoconfig session
protocol : ssh
hostname : SW-Core
host     : 10.1.1.1:22
ip       : 10.1.1.1
username : admin
started  : 2026-10-27T15:15:30.000Z
log      : SW-Core_10.1.1.1_20261027-231530.log
==============================================================================

<设备原始输出>

### [2026-10-27T15:15:35.123Z] INPUT (agent): display version
<设备输出>

### [2026-10-27T15:16:02.000Z] [sftp] LIST /cfg -> 8 entries

==============================================================================
session closed 2026-10-27T15:20:00.000Z exit=0 bytes=12345
==============================================================================
```

- 日志默认单会话上限 32 MB，目录上限 512 MB（超出按最旧优先清理）。
- 密码类输入可通过 `device_send` 的 `sensitive=true` 脱敏；Telnet/串口自动登录的凭据不会写入日志。
- hostname 在识别到之前使用「设备名称」或 IP/串口名占位，识别后原地重命名（保留连接时间）。

## 已知限制

- 高亮只装饰**完整且不含 ANSI 转义**的行：提示符和进度行会立即原样显示（避免为等高亮而延迟输入），设备自带颜色的输出保持原色。
- 串口 Console 的传输层已按 9600 8N1 默认实现并完成端口枚举验证；实际数据收发仍建议在目标 COM 设备上做一次联调。
- 高亮规则来自 `colorful-network.ini`，固定内置，暂不提供运行时编辑入口。

## 安全说明

- SSH 主机密钥校验默认关闭（`hostVerifier: () => true`）。网络设备的自签名/经常重置的主机密钥使 TOFU 很难维护；请仅在可信管理网络中使用，或按需在 `src/transport-ssh.js` 中接入 known_hosts。
- 凭据只在连接时从面板/工具传入，不写入日志、不返回给模型；但会存在于 DSH 进程内存和浏览器的连接表单中。
- 会话栏密码保存在 DSH 凭据库（`ctx.credentials`，引用名形如 `DSH_AUTOCONFIG_..._PASSWORD`），不写入 `~/.dsh/autoconfig-profiles.json`；删除会话时同时删除对应凭据。AI 工具发起的连接只记录地址，不保存密码。
- 所有设备命令由操作者或 AI 发起，插件本身不做命令白名单；请通过 DSH 权限与设备侧 AAA 控制风险。

## 社区与反馈

- 社区插件市场与提交入口：[dsh-plugin.org/zh/submit](https://dsh-plugin.org/zh/submit)
- 问题反馈：[GitHub Issues](https://github.com/liuxin4566-web/dsh-autoconfig/issues)
- GitHub 仓库：[liuxin4566-web/dsh-autoconfig](https://github.com/liuxin4566-web/dsh-autoconfig)

## 开发

```powershell
pnpm install
pnpm run build
node --test test/*.test.mjs
```

- `src/index.js`：host 服务（连接、终端流、日志、SFTP、RPC）。
- `src/transport-ssh.js` / `transport-telnet.js` / `transport-serial.js`：传输层。
- `src/log-store.js`：日志命名、写入、重命名、轮转。
- `src/client/`：右侧面板、xterm、连接对话框、SFTP 文件浏览、日志对话框。
- `scripts/build-host.mjs` / `build-client.mjs`：esbuild 打包（host ESM + client CJS wrapper）。

## 兼容性

- DSH Desktop 0.2.x / Web profile（`sidebarRightTabs` + `sidebarRight`）。
- 右侧面板复用官方 Sidebar 的宽度、分屏、全屏、折叠，不提供旧的浮动抽屉回退。
