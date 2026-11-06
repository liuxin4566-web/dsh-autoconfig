# dsh-autoconfig

[![GitHub](https://img.shields.io/badge/GitHub-liuxin4566--web%2Fdsh--autoconfig-181717?logo=github)](https://github.com/liuxin4566-web/dsh-autoconfig)
[![npm](https://img.shields.io/npm/v/dsh-autoconfig.svg)](https://www.npmjs.com/package/dsh-autoconfig)
[![CI](https://github.com/liuxin4566-web/dsh-autoconfig/actions/workflows/ci.yml/badge.svg)](https://github.com/liuxin4566-web/dsh-autoconfig/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490)](https://github.com/topics/dsh-plugin)

给 DSH（DeepSeek Harness）用的网络设备自动配置终端插件。基于 [dsh-ssh-ops](https://github.com/caoyiwei850/dsh-ssh-ops) 的「主对话驱动 + 右侧终端」架构重新实现，面向路由器、交换机、防火墙等设备的日常配置与排障。

> **安全提示（重要）**：SSH 主机密钥校验默认关闭（`hostVerifier: () => true`），存在中间人攻击风险。请仅在可信管理网络使用；需要校验时，修改 `src/transport-ssh.js` 中的 `hostVerifier`，接入 `~/.ssh/known_hosts` 或设备指纹白名单。详见文末[安全说明](#安全说明)。
>
> **原生依赖**：串口功能依赖 `serialport` 原生绑定。pnpm/DSH 安装器通常会写入 `allowBuilds` 并重试，但若本机没有预编译包且缺少编译工具链，安装可能失败。Windows 需要 Visual Studio Build Tools 的“使用 C++ 的桌面开发”和 Python 3；Linux 需要 `build-essential` 与 `python3`。**不使用串口时，SSH/Telnet/SFTP 不受影响。**

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
- **AI 工具**：`device_connect` / `device_list` / `device_send` / `device_read` / `device_close` / `device_sftp` / `device_logs`，以及 0.2.0 的 `kb_search` / `kb_docs` / `device_profile` / `plan_*`。`device_send` 会在右侧终端留下 `[agent ...]` 标记并写入日志的 `INPUT (agent)` 记录。
- **左侧会话栏**：像 MobaXterm / SecureCRT 一样保存连接过的设备。双击有锁标记（已保存密码）的会话直接重连；没有密码的会话会预填地址，只补密码即可。密码写入 DSH 凭据库，`autoconfig-profiles.json` 只保存地址、用户名和端口。
- **关键字高亮**：内置 `colorful-network.ini` 的 22 条规则（`no/down/error` 红、`up/connected` 绿、协议/端口蓝、路由/ACL 品红、接口/IP/百分比橙），大小写不敏感，按最长匹配避免重叠，且只在整词边界命中（不会把 `Usage` 里的 `ge`、`Canonical` 里的 `no` 染色）。工具栏「高亮」可随时关闭；已带 ANSI 颜色的设备输出原样保留。
- **终端外观**：终端页面默认**纯黑背景**；工具栏可一键切黑/深蓝黑/浅色，或用取色器选任意颜色。背景与高亮开关保存在浏览器 `localStorage`（`dsh-autoconfig.terminal-background` / `dsh-autoconfig.keyword-highlight`）。
- **日志查看**：面板「日志」按钮可预览、下载、删除日志；日志目录默认 `~/.dsh/autoconfig-logs`。
- **手册知识库（0.2.0）**：右侧「知识库」抽屉上传 PDF / CHM / MD 技术手册，填写厂家/系列/型号/适用版本；后台建立 TGM（章节树 + 实体图 + 映射）+ BM25 + 本地向量（bge-m3）混合索引，可选 bge-reranker 重排。
- **配置计划与审批（0.2.0 / 0.2.2）**：AI 先 `device_profile` 采集厂商/型号/版本/序列号并与手册核验，再 `kb_search` 取手册依据；`plan_create` 生成的计划包含每条命令的中文解释、验证命令和回滚命令，并**完整展示在对话中**。操作者直接在对话里确认后，AI 调用 `plan_approve` 记录“对话批准”，再 `plan_execute` 分步写入终端；右侧「计划」抽屉仍保留手动批准入口。批准与命令哈希绑定，改一个字即失效，执行中失败立即暂停。
- **错误识别与 `?` 自愈（0.2.0）**：识别 Comware / VRP / IOS 的 `^` 错误位置与 `% ... found at '^' position` 提示，用 `?` 逐词探测（不回车、不执行），修正后计划回到 draft 由操作者重新批准；失败样本写入本地案例库并注入后续计划。
- **视图自适应（0.2.1）**：`plan_create` 读取终端当前提示符（`<H3C>` 用户视图 / `[H3C]` 系统视图 / `[H3C-xxx]` 子视图），已在系统视图时自动移除重复的 `system-view`，在用户视图时自动补充 `system-view`，子视图会给出警告；执行时再次检测，重复的视图切换命令直接跳过并留下 `[plan skip]` 标记。

## 手册知识库与配置计划（0.2.0）

这一版把 BookRAG 的检索能力内置为本地 sidecar（Python），插件只通过 `127.0.0.1` 的随机端口和一次性 token 访问它；浏览器不直连 sidecar。

- **数据目录**：默认 `~/.dsh/autoconfig-kb`，可用 `~/.dsh/autoconfig-rag.json` 覆盖：

```json
{
  "dataDir": "E:\\dsh-autoconfig-data",
  "python": "E:\\dsh-autoconfig-data\\.venv\\Scripts\\python.exe",
  "modelPath": "E:\\dsh-autoconfig-data\\models\\bge-m3",
  "device": "cuda",
  "autoStart": true
}
```

- **Python 环境**（首次使用，手动准备一次）：

```powershell
E:\Python312\python.exe -m venv E:\dsh-autoconfig-data\.venv
E:\dsh-autoconfig-data\.venv\Scripts\python.exe -m pip install -r sidecar\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
E:\dsh-autoconfig-data\.venv\Scripts\python.exe -m pip install torch==2.5.1+cu121 --index-url https://download.pytorch.org/whl/cu121
E:\dsh-autoconfig-data\.venv\Scripts\modelscope.exe download --model BAAI/bge-m3 --local_dir E:\dsh-autoconfig-data\models\bge-m3
# 可选重排模型：
E:\dsh-autoconfig-data\.venv\Scripts\modelscope.exe download --model BAAI/bge-reranker-v2-m3 --local_dir E:\dsh-autoconfig-data\models\bge-reranker-v2-m3
```

- **无 GPU**：把 `device` 改成 `"cpu"` 即可；没有向量模型时仍可用 BM25 + TGM 词法检索。
- **文档元数据**：上传表单记录厂家、系列、型号、适用版本；检索先按厂家硬过滤，再按型号/版本匹配排序，避免把华为的命令发给 H3C 设备。
- **新增工具**：`kb_search` / `kb_docs` / `device_profile` / `plan_create` / `plan_approve` / `plan_execute` / `plan_status` / `plan_diagnose` / `plan_revise` / `plan_abort`。
- **行为约束**：`plan_execute` 在 host 侧校验批准哈希；AI 必须先把完整计划展示在对话中，取得用户明确同意后才能调用 `plan_approve`，不能跳过对话直接批准。`?` 探测只输入、不回车；`save` / `reboot` / `undo` 管理面等高风险命令在计划里单列风险，执行前由操作者对整份计划一次确认。

## 安装

### 方式一：npm（推荐）

已发布到 npm：[dsh-autoconfig](https://www.npmjs.com/package/dsh-autoconfig)

```powershell
dsh plugin --profile desktop add dsh-autoconfig
# 或 dsh plugin --profile web add dsh-autoconfig
```

> **0.2.0 升级提示**：新增了 `kb_*` / `device_profile` / `plan_*` 工具和本地 sidecar。安装后请**完全退出并重启 DSH Desktop**（含托盘），再刷新页面；仅热重载不会刷新工具清单和宿主路由。
>
> **0.2.1 升级提示**：`plan_create` 新增终端视图检测与自适应；安装后同样需要完全退出并重启 DSH Desktop，新的 `[plan skip]` 与视图调整逻辑才会生效。
>
> **0.2.2 升级提示**：新增 `plan_approve`，支持在对话中完成整份计划的批准，右侧抽屉不再是必经步骤；升级后需完全重启 DSH Desktop 才会加载新工具。
>
> **0.2.3 升级提示**：修复终端关键词高亮在分片数据下几乎不生效的问题——高亮器会缓存跨 chunk 的不完整行，40ms 后自动 flush 提示符；升级后需刷新页面（客户端 bundle）才能看到效果。
>
> **0.2.4 升级提示**：切换「高亮」时会重放当前会话语义，历史输出立即重新着色，不再只影响新输出。
>
> **0.2.5 升级提示**：修复 H3C/Huawei 输出行尾 `\r\r\n` 导致所有设备行被当作“回车进度行”跳过的问题；这是关键词高亮一直不显示的根因。
>
> **0.2.6 升级提示**：CHM 上传/建索引完善：sidecar 重启后自动整理“building”状态（已落盘则恢复 ready，否则标记失败可重建），并阻止同一文档重复排队构建。
>
> **0.2.7 升级提示**：修复预览按钮报 `Manifest.get() takes 2 positional arguments but 3 were given`。

### 方式二：GitHub 源码

```powershell
dsh plugin --profile desktop add github:liuxin4566-web/dsh-autoconfig
# Web profile：
dsh plugin --profile web add github:liuxin4566-web/dsh-autoconfig
```

等价写法：`dsh plugin --profile desktop add git+https://github.com/liuxin4566-web/dsh-autoconfig.git`。

### 方式三：本地 tgz

```powershell
# 在插件源码目录构建并打包
pnpm install
pnpm pack

# 安装到 desktop profile（DSH Desktop 使用的 profile 名）
dsh plugin --profile desktop add .\dsh-autoconfig-0.2.1.tgz
```

若 `dsh` 不在 PATH，请使用 DSH 安装目录中的 `dsh`/`dsh.cmd`，或通过官方 npm 包执行：

```powershell
npx @deepseek-ai/dsh plugin --profile desktop add .\dsh-autoconfig-0.2.1.tgz
```

`dsh plugin add` 会把包加入 profile 依赖，并自动把声明了 `dsh.bundle` 的包加入 `dsh.profile.bundles`。当前 DSH 桌面版是 live profile，通常会热加载；若没有出现标签页，完全退出并重启 DSH Desktop。

> SSH/SFTP 使用的 `ssh2` 已内联进宿主产物（MIT），因此不依赖 profile 对 `ssh2` 的模块解析；只有串口需要的 `serialport` 是运行时依赖。若 profile 暂时无法访问 npm，可先复制 `lib`、`locale`、`package.json`、`cordis.patch.yml` 到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-autoconfig`，并把 `dsh-autoconfig` 加入 profile 的 `dependencies` 与 `dsh.profile.bundles`（串口功能仍需 `serialport` 及其预编译绑定）。

### 串口依赖

`serialport` 带原生绑定，常见平台会优先使用预编译包。若 profile 的 pnpm 拦截了构建脚本，需要允许：

```yaml
# ~/.dsh/profiles/desktop/pnpm-workspace.yaml
allowBuilds:
  '@serialport/bindings-cpp@13.0.0': true
```

然后重新执行安装命令。若没有匹配的预编译包，需要本机编译：

- **Windows**：安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选“使用 C++ 的桌面开发”，并安装 Python 3。
- **Linux**：`sudo apt-get install -y build-essential python3`。
- **macOS**：安装 Xcode Command Line Tools：`xcode-select --install`。

SSH/Telnet/SFTP 不依赖串口绑定；即使 `serialport` 不可用，这三类连接仍可正常使用。

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
