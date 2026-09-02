# 数据、Blob 与网页发布规范

## 1. Vercel Blob

PDF 是公开网页内容，使用 Vercel Blob `access: "public"`。不要为公开 PDF 使用 private Blob 后再由函数代理，以免增加延迟和流量成本。

稳定路径格式：

```text
daily-books/YYYY/MM/DD/{slug}-{content-version}.pdf
daily-books/YYYY/MM/DD/{slug}-{content-version}-cover.webp
```

- `slug` 使用小写 ASCII、数字和连字符，来源于英文书名或稳定 ID。
- 同一路径不得静默覆盖。内容改变时增加 `content-version`。
- 上传后保存 `url`、`pathname`、文件大小、SHA-256 和 ETag（若接口返回）。
- 上传后以公开 URL 获取文件，验证 200、`Content-Type: application/pdf`、大小和本地文件一致。
- 不在日志或仓库中保存 `BLOB_READ_WRITE_TOKEN`。

新版验证成功后，清理同一业务日期、同一书名且状态仍为 `pending` 的旧版本 manifest 与 PDF。当前 job 必须是同书最新任务；不得接受调用方传入任意 Blob 路径，不得删除 `data.json` 已引用的正式 PDF。清理失败时保留当前版本并报告，不得扩大删除范围。

## 2. `data.json` 兼容契约

发布前以现有 `data.json` 实际结构为准。当前必需字段为：

```json
{
  "id": 0,
  "date": "YYYY-MM-DD",
  "title": "中文书名",
  "originalTitle": "Original Title",
  "author": "作者",
  "description": "80-140 字原创简介",
  "tags": ["标签1", "标签2", "标签3"],
  "highlights": ["洞见1", "洞见2", "洞见3"],
  "action": "今天可以执行的一项动作",
  "duration": "20分钟",
  "rating": "",
  "category": "主题分类",
  "cover": "",
  "audio": "",
  "audioUrl": "",
  "pdf": "https://...pdf",
  "pdfUrl": "https://...pdf"
}
```

规则：

- 新记录插入数组首位。
- `id` 在全量目录中唯一且遵循项目当前生成策略，不按数组位置重排历史 ID。
- `date` 使用业务日期，即北京时间日期。
- `highlights` 是 PDF 5 个洞见中最重要的 3 个短句，不复制长段正文。
- `action` 必须能在当天执行并留下可检查产物。
- `pdf` 和 `pdfUrl` 都使用同一个已验证的 public Blob URL，以兼容现有页面逻辑。
- `rating` 不是本地 Agent v1 的必填字段；没有可核实评分时传空字符串，由页面使用现有展示兜底，不在管理流程中伪造评分。
- 新内容没有音频时，`audio` 和 `audioUrl` 传空字符串。
- `cover` 优先使用已获授权或可合理公开使用的封面；不确定时生成项目自己的文字封面，不盗链受限图片。
- 新增审计字段前先确认 `script.js` 和知识库构建脚本可忽略未知字段；未验证兼容性时不要扩展 schema。

## 3. 知识库更新

在提交目录前运行项目现有的知识库构建流程。当前入口是：

```text
python tools/build_book_knowledge.py
```

构建时使用已通过验收的本地 PDF，不依赖刚上传的远程 URL。确认 `knowledge/books.json` 中新增书籍的标题、摘要和页数可检索，且没有覆盖或删除历史条目。

## 4. 提交与部署

- 只提交本次成功运行产生的源数据、知识库和审计清单；不夹带用户已有的无关改动。
- 提交信息包含业务日期与书名，例如 `content: add daily book for 2026-09-02`。
- 依赖现有 GitHub 到 Vercel 的生产部署链路；不要把 preview 部署误认为成功。
- 若仓库当前存在冲突或无法安全隔离的用户改动，停止自动提交并记录 `workspace_conflict`。
- 部署失败时不创建第二条目录记录，不覆盖已有 PDF；保留可恢复状态供后续继续。

## 5. 上线验证

生产部署完成后按完整用户故事验证：

1. 首页能加载且控制台无新增致命错误。
2. 当天书籍出现在最新位置，标题、作者、封面、时长和标签正确。
3. 详情页或 PDF 入口能打开当天 PDF。
4. PDF URL 返回 200 和 `application/pdf`，第一页能渲染。
5. 站内搜索或 RAG 能检索到当天书籍的至少一个核心洞见。
6. `data.json` 生产版本包含且只包含一条当天记录。

线上任一关键边界失败时，状态不得标记成功。优先修复或回滚目录提交；不得留下指向失效 Blob 的公开记录。
