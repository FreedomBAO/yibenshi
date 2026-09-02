# 本地 Agent 生成后上传

当前链路不依赖 Coze 工作流：

```text
本地 Agent 生成 PDF + 同名 JSON
  -> 本地上传脚本
  -> Vercel 接收接口
  -> public Vercel Blob + pending 任务
  -> Codex 每天 02:30 验收、更新 Git、部署
```

## 输出目录

默认目录：

```text
C:\Users\67139\Documents\DailyBooks\pdf
```

每次必须生成同名文件对：

```text
底层逻辑.pdf
底层逻辑.json
```

生成过程中可先使用临时扩展名，全部写完并关闭文件后再改为 `.pdf` 和 `.json`，避免上传脚本读到半成品。

## JSON 模板

```json
{
  "book_name": "底层逻辑",
  "book_name_en": "Underlying Logic",
  "author": "刘润",
  "intro": "40-1000 字原创简介",
  "tags": ["认知", "思维模型", "方法论"],
  "highlights": ["亮点1", "亮点2", "亮点3"],
  "action_advice": "今天能够执行并留下结果的一项行动",
  "category": "认知提升",
  "read_minutes": 20,
  "cover": ""
}
```

`cover` 没有可靠公开 URL 时保持空字符串。不要写本地图片路径或 Base64 图片。

## Agent 完成后的命令

本地 Agent 在 PDF 和 JSON 都生成完成后执行：

```powershell
python "D:\每天精读一本书\tools\upload_daily_book.py" --pdf "C:\Users\67139\Documents\DailyBooks\pdf\底层逻辑.pdf"
```

如果 Agent 无法确定当天文件名，可执行：

```powershell
python "D:\每天精读一本书\tools\upload_daily_book.py"
```

脚本会选择输出目录中最新的完整 PDF/JSON 文件对。首次接入时可先运行：

```powershell
python "D:\每天精读一本书\tools\upload_daily_book.py" --dry-run
```

## 成功判定

成功时标准输出为一行 JSON，其中包括：

```json
{
  "ok": true,
  "duplicate": false,
  "job_id": "...",
  "status": "pending",
  "pdf_url": "https://...public.blob.vercel-storage.com/...pdf"
}
```

脚本会在输出目录生成同名回执：

```text
底层逻辑.uploaded.json
```

相同 PDF 已有成功回执时，脚本直接返回 `already_uploaded`；使用 `--force` 才会再次请求。接口本身也按 PDF 和元数据保持幂等。

密钥只从项目根目录 `.env.local` 或进程环境变量读取，不写入命令、JSON、回执或日志。
