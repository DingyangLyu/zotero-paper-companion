# Paper Companion · Zotero 论文助手

作者：**dingyanglyu**。Zotero 10 阅读器插件：PDF 划词即时翻译 + 基于整篇论文的问答。

## 功能

**划词翻译**：在 PDF 中选中文字，Zotero 原生弹窗下方直接出现译文。无需点击；结果流式显示，通常 2–5 秒完成。
- 单词/短语给出「本文语境下的译法 + 一句话含义」；句子和段落只输出译文。
- 选区所在段落及前后段落作为消歧上下文。读取不到时不阻塞，直接翻译。
- 卡片上的操作：**复制**、**重译**、**解释**（把选区带到右侧并立即解释）、**提问**（带到右侧，由你输入问题）。顶部可直接切换翻译模型。
- 同一选区的译文会缓存。Zotero 重新渲染弹窗时会接回正在进行的翻译，不会重新请求。关闭弹窗 1.5 秒后取消未完成的请求。
- 安装了 Translate for Zotero 时，可在同一弹窗里隐藏它的翻译区（可在设置中关闭）。

**论文问答**：在阅读器右侧栏的「论文助手」中提问。
- 论文不超过上下文上限（默认约 15 万字符）时整篇发送。超出时保留开头几页、选区附近页和与问题相关的段落。
- 回答中的 `[p.N]`（以及 `[p.7-8]`、`[p.2, 5]`）渲染为页码按钮，点击跳转。支持 Markdown、KaTeX 公式和表格；表格比侧栏宽时横向滚动，不会把列挤成一字一行。
- 「深度思考」开关：关闭时更快（首字约 3–8 秒），开启时更严谨（首字多等 10 秒以上）。
- 空对话提供常用问题；Enter 发送，Shift+Enter 换行，正确处理中文输入法组字；失败的回答可「重试」。
- 每篇论文一份对话，切换模型不丢上下文。「新对话」会把旧对话归档保存。
- 问题在发出的同时就写入磁盘。Zotero 重建侧栏（切换标签页、重新载入阅读器等）不会打断正在生成的回答，也不会丢失或覆盖已有消息。
- 回答生成中再按 Enter 会保留输入并提示；模型 120 秒没有任何输出时自动中断并可「重试」。

## 模型服务

在 **Zotero → 设置 → 论文助手** 中管理：

| 类型 | 说明 |
| --- | --- |
| Anthropic Messages 兼容 API | 例如 Kimi K3（`https://api.kimi.com/coding/v1`，模型 `k3`）。翻译请求会关闭 thinking 以加快速度 |
| OpenAI Chat Completions 兼容 API | DeepSeek、OpenRouter、本机 vLLM/Ollama 等 |
| OpenAI Responses API | |
| Codex / Claude Code / OpenCode CLI | 本机 Agent，只读运行；每次调用都要启动完整进程，通常 10–30 秒 |

- **从 OpenCode 导入**：读取 `~/.config/opencode/opencode.json(c)` 中带 `baseURL` 和 `apiKey` 的服务，一键导入。
- 每个服务都有「测试」按钮，会显示耗时和返回内容，或可读的错误原因（Key 无效、地址错误、限流等）。
- API Key 存在 Zotero 的密码管理器（Mozilla Login Manager），不写入偏好设置或对话记录。
- 0.1.x 的引擎配置在首次启动时自动迁移。本机 CLI 路径失效（如 nvm 升级）时会自动重新检测。

## 安装

下载 [`dist/paper-companion-0.2.2.xpi`](dist/paper-companion-0.2.2.xpi)，在 Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File 中选择该文件。之后 Zotero 会通过仓库里的 `updates.json` 自动更新。

支持 Zotero 10.x。开发与实机验证使用 macOS 上的 Zotero 10.0.6。

## 数据与隐私

- 只有在翻译或提问时才会调用模型。发送内容为选区、上下文段落或论文文本，不上传 PDF 文件。
- 对话保存在 `<Zotero 数据目录>/paper-companion/<libraryID>_<key>/chat.json`，不会写入 Zotero 笔记或同步。
- 诊断日志 `<Zotero 数据目录>/paper-companion/debug.log` 只记录事件、耗时和错误信息（不含论文、问题或回答内容），超过 256 KB 自动轮换。
- CLI 引擎在插件独立的 runtime 目录中只读运行：Codex 使用 read-only sandbox，Claude Code 关闭工具与 MCP，OpenCode 拒绝所有权限。

## 0.2.2

修复侧栏回答的 Markdown 显示：

- 部分回答显示成一整段原始文本（`###`、`**`、`$` 原样出现、没有换行）。原因是 Zotero 主窗口是 XML 文档，原来用 `innerHTML` 解析 Markdown 生成的 HTML，回答里只要有单个换行（`<br>`）或分隔线（`<hr>`）就解析失败。现在改用 HTML 解析器。
- 表格不再被挤成每行一个字：短单元格（名称、数字、表头）不换行，长单元格按内容保留可读宽度；表格比侧栏宽时横向滚动，边缘有阴影提示，并保留列对齐。
- 修复表格、输入框、模型选择框和设置页卡片的边框不显示（误把 Zotero 的边框简写变量当颜色使用）。
- 调整标题、列表、行内代码、分隔线和公式的间距；支持五、六级标题和上下标。万一渲染失败，也会保留原文换行。

## 0.2.1

修复侧栏问答「消息被吞」：0.2.0 的对话只保存在侧栏界面里，回答完成后才写盘，错误提示又显示在输入框下方、常被挤出可视区域。侧栏被 Zotero 重建、重绘出错或请求卡住时，新问题和尚未保存的消息会一起消失。0.2.1 中：

- 对话状态按论文保存在界面之外，侧栏重建后直接接回，回答继续流式显示；问题发出即写盘。
- 单条消息渲染失败只影响这一条，不会清空整个对话。
- 输入区（选区、提示、输入框）固定在侧栏底部，提示始终可见；回答结束后「生成中」提示自动清除。
- 生成中按 Enter 不再无反应，会保留输入并说明原因；输入法确认候选的回车不会误发送。
- 读取论文全文时，Zotero 结构化文本接口超时会回退到 pdftotext，「停止」立即生效；模型 120 秒无输出自动中断。
- 回答中的 `[p.7-8]`、`[p.2, 5]` 这类页码范围也渲染为可点击的页码。
- 新增本地诊断日志 `debug.log`。

## 0.2.0 相比 0.1.x 的变化

0.1.x 只能调用本机 Agent CLI。实测 Codex 回复一个「OK」就要约 22 秒，OpenCode 约 10 秒，而且不流式输出。划词后还要手动点「翻译」。弹窗被 Zotero 重新渲染时，正在进行的翻译会被丢弃。侧栏按钮多、设置挤在侧栏里，使用体验很差。0.2.0 重写为：

- 以直连 API 为主路径（流式；翻译关闭 thinking）。CLI 保留为备选，在模型列表中排在后面。
- 选区即翻译；翻译任务与弹窗 DOM 分离，弹窗重绘不再中断翻译。
- 设置移到 Zotero 设置页；侧栏只保留模型、深度思考、新对话和设置。
- 问答默认整篇论文作为上下文（0.1.x 为最多 6 万字符的抽样）。
- 代码按模块重写，便于维护：`core`（提示词与上下文）、`providers`（API/CLI）、`services`（Zotero 数据）、`popup`、`sidebar`、`settings`。

## 开发

```sh
npm ci
npm run check      # 语法检查 + 单元测试
npm run build      # 生成 dist/paper-companion-<版本>.xpi、SHA256SUMS、updates.json
```

`npm run build:dev` 生成 `-dev.xpi`。它额外包含 `dev/devbridge.js`：一个仅限本机、需令牌的 Zotero 内部测试端点，令牌每次启动重新生成，并写入 `<Zotero 数据目录>/paper-companion/.devbridge-token`（600 权限）。安装 dev 版后：

```sh
dev/zeval.sh 'return Zotero.version'   # 在 Zotero 内执行 JS
dev/reload.sh                           # 重新构建并热重载插件
```

发布版 XPI 不包含该端点。

## 第三方组件

KaTeX 0.18.4、marked 18.0.14，均为 MIT 许可证，见 `THIRD_PARTY_NOTICES.md`。
