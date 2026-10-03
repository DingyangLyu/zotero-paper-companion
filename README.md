# Paper Companion · Zotero 论文助手

作者：**dingyanglyu**。

独立的 Zotero 10 阅读器插件：在 PDF 旁边进行划词翻译和论文问答，支持切换 Codex、Claude Code、OpenCode 或自定义 API。

## 已实现

- 右侧论文助手：引擎、模型、配置、按论文和引擎隔离的本机聊天记录、引用选区、上下文、发送和停止。
- 划词弹窗直接显示译文：选择一个词、多个词或一段文字后点击“翻译”，原位查看流式结果、复制、停止或重新翻译。附近段落用于消歧，可展开检查实际引用原文；“提问”继续把选区带到右侧聊天。弹窗可切换引擎，模型及 API 沿用该引擎配置。
- 同一篇论文、同一选区与相同模型/上下文的译文在本次阅读期间缓存于内存，重复查看无需重新推理；重新翻译会绕过缓存。关闭弹窗、重新划词、切换论文或禁用插件时取消旧请求，迟到结果不会覆盖新选区。
- 如果同时安装 Translate for Zotero，仅在新划词弹窗中隐藏其旧翻译区域，避免 CNKI 报错占位；保留 Zotero 原生标注控件，旧插件的其他入口不变。
- 默认取选区所在段落及前后各一段，可改成各两段；用页码和段落坐标区分同页重复术语。跨段、跨页选区可保留相邻上下文；定位失败会明确提示并退回所选原文。
- 本机用 Zotero 10 的 SDT 读取逻辑段落和 PDF 坐标；SDT 无法读取时可使用已安装的 pdftotext。扫描件没有 OCR 文字时提示先 OCR。
- 短论文可作为有界全文提供给 QA；长文结合关键词和分布式段落取样，最多约 60000 字符。界面中的“本次引用的上下文”可检查实际发送范围；长文取样不保证覆盖所有证据，优先使用划词 QA。
- Markdown 标题、列表、表格、引用、代码及 KaTeX 公式。支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`、equation / align / aligned / gather。无法解析的公式保留 TeX 源码。
- 回答中的 `[p.N]` 或 `[来源](paper://page/N)` 可跳回当前 PDF 的物理第 N 页。链接仅对本次实际提供的页面生效。网页链接经用户点击打开系统浏览器。

## 安装

交付文件：`dist/paper-companion-0.1.5.xpi`。

Zotero → 工具（Tools）→ 插件（Plugins）→ 齿轮 → Install Plugin From File，选择 XPI。打开一份 PDF，在右侧栏选择“论文助手”。安装后已打开的 PDF 如果暂未显示划词入口，重新打开该 PDF 标签页即可。

声明支持 Zotero 10.0.*；开发与原生检查使用 macOS Zotero 10.0.4。没有声明 Zotero 7/8/9 或 Windows 已通过验证。本版手动安装/更新，没有自动更新服务。

## 配置

在弹窗或侧栏点击“配置”（配置表单显示在侧栏）。插件启动时会自动发现已安装的 Codex、Claude Code 和 OpenCode；手动填写的路径会保留。

- **Codex / Claude Code / OpenCode**：选择本机已有的可执行文件，或输入绝对路径。Codex 模型可从“刷新模型”读取的本机目录中选择；留空时读取目录推荐的默认模型，不再直接继承全局配置中的模型名。Claude Code / OpenCode 可填写模型名称，留空沿用自身默认设置。CLI 使用自身已有的登录、提供商和 API 配置；插件不下载 CLI、不修改其全局配置。右侧顶部的模型字段可随时更改，忙碌时锁定。
- **自定义 API**：点击“添加自定义 API”，填写显示名称、Base URL、模型和 API Key。支持 OpenAI Chat Completions 兼容接口、Responses、Anthropic Messages。Base URL 应为服务 API 根地址，例如 `https://api.example.com/v1`；本机 `http://127.0.0.1:.../v1` 也可使用。
- API Key 保存在 Mozilla Login Manager，普通偏好与聊天记录中不保存密钥。留空保留已存密钥；“清除已保存的 API Key”可删除当前接口密钥。
- 可设置翻译/回答语言及附近段落数量。

## 数据与执行

只有点击翻译、发送问题时才调用引擎，选区和实际引用段落会由该引擎交给其模型提供商。打开侧栏、切换论文或配置引擎不会发起模型请求。

聊天记录保存在 Zotero 数据目录的 `paper-companion/<libraryID>_<attachmentKey>/<engineID>.json`，不会自动写入 Zotero 笔记、批注或同步服务。本文原始 PDF 不会自动上传到聊天接口。CLI 获得文字上下文，工作目录为插件的独立 runtime 目录；Codex 使用 read-only sandbox，Claude Code 关闭内置工具/MCP，OpenCode 使用禁止工具的权限配置。CLI 用户自身的登录和机器配置仍由 CLI 管理。

Codex 使用 `exec --json`；Claude Code 使用 `--print --output-format stream-json`；OpenCode 使用 `run --pure --format json`。每轮通过本机记录恢复文字对话；本版没有持久的 agent-server 会话、工具授权卡片、图片 QA 或全篇排版翻译。

## 开发与验证

```sh
npm ci
npm run check
npm run build
```

运行时源码在 `plugin/`；测试在 `tests/`；构建工具在 `scripts/`。XPI 只包含运行时文件。

本次 38 项测试涵盖上下文定位和限幅、跨段选择、请求结构、分块 UTF-8 流式输出、错误处理、公式与不可信 HTML、引用链接、论文切换、迟到结果、侧栏发送和弹窗内翻译。弹窗测试另覆盖缓存及刷新、停止/关闭/换选区时的取消、API 切换、复制、旧插件区域隐藏及恢复、原生 CSS translate 定位，以及阅读器与主窗口的 Gecko 脚本环境隔离。

本地验证报告记录 Zotero 10.0.4 的原生检查：最终 XPI 解析、真实 PDF 的段落/坐标提取、原生 MathML 渲染和三种引擎协议的合成本地管道。早期合成管道验证使用测试进程；最终 0.1.3 验证已通过 Zotero 内的 Codex 实际发送选区翻译和论文 QA。0.1.3 已安装并启用，真实侧栏检查通过：三引擎切换均为就绪，本机路径候选、自定义 API 三协议表单、选区草稿和聊天控件均正常。Codex 的真实选区翻译和 QA 已验证：samples 翻译为“样本”，使用了同页附近段落，回答中的 LaTeX 公式与页码引用已渲染。页码跳转由用户确认正常。0.1.5 另已通过 OpenCode 的真实弹窗翻译；Claude Code 和自定义 API 的真实推理连通性尚未逐一验证。

## 参考与复用

- 参考 [LMMs-Lab Writer](https://github.com/DingyangLyu/lmms-lab-writer) 的引擎/模型入口、选区引用、聊天记录和公式呈现结构，主体为独立实现。
- `dingdinglz/zotero-translate` 和 `andrepaim/pdfpal` 用作流程参考；未直接复制其无明确许可证的业务源码。
- 复用 KaTeX 0.18.4 与 marked 18.0.14，均保留 MIT 许可证。KaTeX 通过显式导出 bundle 适配 Zotero 的脚本作用域，生成原生 MathML。
- Zotero 生命周期、Reader 事件、Item Pane 和文本接口依照官方文档和本机 10.0.4 源码核对。

模型目录通过本机 Codex app-server 的 `model/list` 查询；只读取模型元数据，不创建对话或发送提示词。官方接口说明：https://developers.openai.com/codex/app-server/ 。

0.1.5 已修复阅读器脚本环境无法读取观察器参数的问题：DOM 仍使用官方 Reader 事件提供的文档，观察器、请求取消、计时器与网络 IO 使用 Zotero 主窗口。最终 XPI 已由 Zotero 10.0.4 原生解析并安装；真实 PDF 划词已显示新弹窗，旧 CNKI 弹窗区域已隐藏。真实 OpenCode 请求已完成：在 PDF 第 4 页选中 abductive 后，译文“溯因（推理）”及基于附近段落的解释直接显示在弹窗；没有新增侧栏翻译消息。原生标注颜色和高亮/下划线控件保留，译文可滚动，复制与上下文入口正常显示。
