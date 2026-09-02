---
name: daily-book-pdf-pipeline
description: 为“每天精读一本书”项目选择一本非虚构图书，研究并撰写中文知识卡片式精读，生成标准化 PDF，通过 Vercel Blob 与现有 data.json 发布，并执行全链路验收。用于每日自动任务、单次补跑、内容返工或流水线故障恢复；不用于转载原书或生成章节级替代品。
---

# 每日精读 PDF 流水线

为普通青年读者制作一份 18-22 分钟可读完、包含实例和可执行 SOP 的原创图书精读。默认全自动运行，主题不限于自我提升、金融商业和个人成长，但必须具备长期价值与现实可操作性。

## 开始前

1. 从仓库根目录工作，先读取 `data.json`、`README.md`、`vercel.json` 和最近一次运行清单；不得凭记忆假设当前数据结构。
2. 运行任何发布动作前，确认 `CRON_SECRET`、Vercel Blob 凭据和仓库写入凭据已配置。只检查是否存在，不输出密钥。
3. 每个北京时间自然日只允许一条成功记录。幂等键为 `daily-book:YYYY-MM-DD`；已有成功记录时直接返回 no-op。
4. 外部写入前，必须先在本地完成研究、写作、PDF 生成和全部硬性验收。

## 执行路由

- 选书、研究或写作时，读取 [references/content-spec.md](references/content-spec.md)。
- 生成或修改 PDF 时，读取 [references/pdf-spec.md](references/pdf-spec.md)，并使用 `pdf` Skill 的渲染与检查流程。
- 定时、幂等、上传、更新网页或恢复失败任务时，读取 [references/pipeline.md](references/pipeline.md) 与 [references/publishing.md](references/publishing.md)。
- 决定是否允许发布时，必须读取 [references/acceptance.md](references/acceptance.md)，逐项生成机器可读的验收结果。

## 必须遵守的产品约束

- 输出是原创知识提炼，不是原书原文、逐章复述或可替代原书的内容。
- 标准版本为 A4 竖版 12-15 页，目标 14 页；中文正文约 5,000-7,000 字符。
- 固定包含 5 个核心洞见；每个洞见至少 2 个例子和 1 套 4-6 步 SOP。
- 事实性案例、作者案例与合成情境必须显式标注，不得把合成案例写成真实事件。
- 经验性、统计性或因果性主张须有可靠证据。使用 Consensus 时必须先 search，再 fetch 原文详情后才能引用。
- 新 PDF 存入 public Vercel Blob；网页仍以 `data.json` 为兼容主数据源，新记录放在数组首位。
- 任一硬性验收失败都不得发布。不得以空白占位、失效链接或低质量短稿赶上当天任务。

## 权限与停止条件

本 Skill 描述完整自动化流程，但不扩大当前任务的外部写入权限。只有在调用方已授权且凭据已配置时，才可上传 Blob、提交仓库或触发生产发布。

遇到以下情况停止并保持线上版本不变：可靠资料不足、发现重复选书、PDF 两次再生成后仍不合格、必要凭据缺失、Blob 上传失败、提交或部署失败。记录失败阶段、可重试性和非敏感错误摘要。
