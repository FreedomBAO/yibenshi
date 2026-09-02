# 本地 Agent 每日精读接收接口

## 对接参数

- 方法：`POST`
- 生产 URL：`https://dailybooks-three.vercel.app/api/coze-ingest`
- Content-Type：`application/json`
- 鉴权：`Authorization: Bearer <COZE_INGEST_TOKEN>`
- 文件格式：PDF Base64 字符串，不使用 multipart。
- PDF 限制：50 KB-10 MB，必须包含有效的 `%PDF-` 文件头和 `%%EOF` 结束标记。

`COZE_INGEST_TOKEN` 是兼容保留的接收密钥名，只保存在本地 `.env.local` 与 Vercel Production 环境变量中，不写进 Agent 指令、仓库或日志。

## 请求 JSON

```json
{
  "file_base64": "JVBERi0xLjcK...",
  "file_name": "20260903_underlying-logic.pdf",
  "book_name": "底层逻辑",
  "book_name_en": "Underlying Logic",
  "author": "刘润",
  "intro": "40-1000 字的原创简介",
  "tags": ["认知", "思维模型", "方法论"],
  "highlights": ["亮点1", "亮点2", "亮点3"],
  "action_advice": "今天能够执行并留下结果的一项行动",
  "category": "认知提升",
  "read_minutes": 20,
  "cover": ""
}
```

字段约束：

| 字段 | 类型 | 要求 |
|---|---|---|
| `file_base64` | string | 必填；纯 Base64 或 `data:application/pdf;base64,` 前缀均可 |
| `file_name` | string | 必填；5-180 字符，以 `.pdf` 结尾 |
| `book_name` | string | 必填；1-100 字符 |
| `book_name_en` | string | 可选；最多 160 字符 |
| `author` | string | 必填；1-100 字符 |
| `intro` | string | 必填；40-1000 字符 |
| `tags` | string[] | 必填；2-5 项，每项最多 20 字符 |
| `highlights` | string[] | 必填；必须正好 3 项，每项最多 120 字符 |
| `action_advice` | string | 必填；10-500 字符 |
| `category` | string | 必填；1-30 字符 |
| `read_minutes` | integer | 必填；5-120 |
| `cover` | string | 可选；有效的 http(s) URL，无法确定时传空字符串 |

日期不由 Coze 传入。接收端按 `Asia/Shanghai` 的实际接收时间生成业务日期，防止 Coze 与服务器时区不一致。

## 成功响应

首次接收返回 HTTP `201`：

```json
{
  "ok": true,
  "duplicate": false,
  "job": {
    "jobId": "cdd16b6fda91718f4ea5",
    "status": "pending",
    "businessDate": "2026-09-03",
    "receivedAt": "2026-09-02T18:15:00.000Z",
    "pdf": {
      "url": "https://xxx.public.blob.vercel-storage.com/daily-books/2026/09/03/underlying-logic-cdd16b6fda91718f4ea5.pdf",
      "pathname": "daily-books/2026/09/03/underlying-logic-cdd16b6fda91718f4ea5.pdf",
      "size": 123456,
      "sha256": "...",
      "contentType": "application/pdf"
    },
    "metadata": {}
  },
  "manifestUrl": "https://xxx.public.blob.vercel-storage.com/daily-books/_pending/2026/09/03/cdd16b6fda91718f4ea5.json"
}
```

相同 PDF 和相同元数据重复推送时返回 HTTP `200`、`duplicate: true`，不会重复写入。

## 清理旧 pending 版本

新版上传并验证可公开读取后，上传器调用同一 URL 的 `DELETE`，使用相同 Bearer Token：

```json
{
  "job_id": "当前最新 job_id",
  "business_date": "2026-09-03",
  "book_name": "底层逻辑"
}
```

服务端只删除同一日期、同一书名、状态为 `pending` 且早于当前 job 的 PDF 和 manifest。当前 job 必须是同书最新任务；客户端不能传 Blob 路径，因此无法借此删除任意文件。删除前还会读取生产 `data.json`，网站已引用的 PDF 一律进入 `protectedJobIds` 而不删除；生产目录不可读取时清理失败并保持所有文件。

## 错误响应

| HTTP | code | 含义 |
|---:|---|---|
| 400 | `INVALID_JSON` | JSON 无法解析 |
| 401 | `UNAUTHORIZED` | Bearer Token 错误 |
| 415 | `JSON_REQUIRED` | Content-Type 不是 JSON |
| 422 | `VALIDATION_FAILED` | 字段或 PDF 不合格，查看 `details` |
| 502 | `BLOB_WRITE_FAILED` | Blob 暂时失败，可原样重试 |
| 503 | `SERVICE_NOT_CONFIGURED` | Vercel 环境变量尚未配置 |

Coze 对 502 和网络超时最多重试 2 次；对 400、401、415、422、503 不要自动重试。

## Codex 管理读取

Codex 每天北京时间 02:30 调用：

```text
GET https://dailybooks-three.vercel.app/api/coze-ingest?date=YYYY-MM-DD
Authorization: Bearer <CODEX_MANAGER_TOKEN>
```

接口返回当天 `pending` 任务。随后 Codex 下载 PDF、执行内容/PDF 验收、更新 `data.json` 和 `knowledge/books.json`、提交 Git、等待 Vercel production 部署并完成线上验证。
