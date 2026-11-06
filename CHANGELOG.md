# Changelog

## 1.0.0 — 2026-11-07

首个正式大版本：把 BookRAG 风格的本地手册检索与网络设备自动配置终端合并为一个可审计的 DSH 插件。

### 手册知识库（RAG）

- 支持上传 PDF（文字可选型）、CHM、MD 技术手册，填写厂家/系列/型号/适用版本。
- 建立 TGM（章节树 + 实体图 + 映射）+ BM25（jieba）+ 本地 bge-m3 向量混合索引，可选 bge-reranker-v2-m3 重排。
- PDF 使用书签还原章节并跳过目录页；CHM 通过 `hh.exe` 解压、解析 `.hhc` 目录；MD 按标题层级切分。
- `kb_search` 按设备厂家硬过滤，型号/版本匹配优先，返回章节路径、页码/行号与命中通道。
- CHM 构建加固：sidecar 重启后自动整理中断的 `building` 状态，同一文档重复构建会复用任务；预览接口修复 `Manifest.get()` 参数错误。

### 设备核验与档案

- 连接后自动采集 `display version` / `display device manuinfo` 等只读信息，识别厂家、型号、版本、序列号、hostname。
- 设备档案按 `deviceId` 持久化到 `~/.dsh/autoconfig-devices.json`，支持导出/导入。
- 手册与设备做 vendor/model/version 匹配；存在精确匹配时只检索精确手册，否则显式提示 fallback。

### 配置计划与执行

- `plan_create` 生成包含逐条命令解释、验证命令、回滚命令、风险等级和手册引用的计划，并在对话中完整展示。
- 终端视图自适应：识别 `<H3C>` / `[H3C]` / `[H3C-xxx]` / IOS `(config)#` 等提示符，自动移除重复 `system-view`、在用户视图补充入口命令，执行时再次检测并跳过重复切换。
- 一次批准后按步骤写入右侧终端；每条命令带 `[plan] 命令 — 解释` 标记，失败立即暂停。
- 对话批准：`plan_approve` 记录操作者在对话中的明确同意，批准与计划哈希绑定；计划被修订后自动回到 draft。
- 严格模式：`requirePanelApproval: true` 时宿主拒绝 `plan_approve`，只允许右侧「计划」抽屉的操作者批准。

### 错误识别与自愈

- 识别 Comware / VRP / IOS 的 `^` 错误位置与 `% ... found at '^' position` 提示。
- `plan_diagnose` 用 `?` 逐词探测（不回车、不执行），`plan_revise` 修正后需重新批准。
- 失败样本写入 `~/.dsh/autoconfig-errors.jsonl`，后续计划会注入相似历史坑。

### 终端与运维体验

- 右侧终端、SFTP、Telnet、串口、日志查看与下载。
- 关键词高亮：支持跨 SSH 分片行、H3C `\r\r\n` 行尾；切换高亮会重放历史输出。
- 终端背景色与高亮开关持久化；自动会话日志按 `<hostname>_<ip>_<timestamp>` 命名。

### 安全说明

- 配置计划批准是**流程性防护**，不是强制访问控制。默认对话批准由 Agent 调用 `plan_approve` 完成；在提示词注入、模型策略偏差或工具编排错误时，存在未经操作者真实批准即写入配置的可能。
- 需要更强门禁时设置 `requirePanelApproval: true`，或移除/禁用 Agent 的 `plan_execute`，仅由前端执行。
- 生产环境应以设备侧 AAA、命令授权、ACL 与变更审计作为最终安全边界。

### 兼容性

- 需要 DSH Desktop / DSH Web 的插件运行时；Node.js 24+，Windows 优先（CHM 解压依赖 `hh.exe` 或 7-Zip）。
- 本地 sidecar 需要 Python 3.10+、PyTorch（CUDA 可选）与 bge-m3；无 GPU 时可设 `"device": "cpu"`。