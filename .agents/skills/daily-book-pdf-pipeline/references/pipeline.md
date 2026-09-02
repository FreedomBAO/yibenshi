# 自动化流水线与故障恢复

## 1. 运行方式

- 业务时区：`Asia/Shanghai`。
- 每日触发时间：北京时间 02:00。
- Vercel Cron 使用 UTC，默认计划为 `0 18 * * *`，即每天 18:00 UTC 触发下一自然日北京时间 02:00 的任务。
- Cron 路径必须指向专用 API 函数；只在 production 部署执行。
- 入口必须校验 `Authorization: Bearer ${CRON_SECRET}`，不匹配时返回 401 且不做任何工作。
- 为兼容函数最大运行时间，Cron 入口宜只创建/续跑作业；长流程应拆为可恢复阶段。实现时必须核对当前 Vercel 套餐的 Cron 数量、频率和函数时长限制。

## 2. 状态机

每次运行以北京时间日期创建 `run_id` 和幂等键，状态只能按以下方向推进：

`created -> selected -> researched -> drafted -> rendered -> validated -> blob_uploaded -> superseded_cleaned -> catalog_committed -> deployed -> verified -> succeeded`

失败状态为 `failed`，并记录 `failed_stage`、`retryable`、`attempt`、`error_code` 和脱敏后的 `error_summary`。不得跳过 `validated` 直接上传，不得在 `catalog_committed` 前标记成功。

## 3. 标准步骤

1. **预检**：验证日期、幂等键、必要环境变量、仓库工作区与当前生产状态。
2. **读取目录**：读取 `data.json` 全量数据和最近运行清单。
3. **选书**：建立至少 3 本候选、执行去重和评分、选择最高分候选。
4. **研究**：建立来源清单与主张-证据表；Consensus 主张完成 search + fetch。
5. **写作**：按固定内容结构生成 5 个洞见、至少 10 个例子和 5 套 SOP。
6. **生成 PDF**：先生成本地中间稿，再生成最终 PDF 与封面图。
7. **硬性验收**：运行内容、证据、PDF 与数据校验；输出验收 JSON。
8. **上传 Blob**：上传最终 PDF 和必要封面，验证公开 URL、大小与 SHA-256；成功后删除同日同书且未发布的旧 pending PDF 与 manifest。
9. **清理本地**：仅保留最终 PDF、同名 JSON 和最新上传回执；删除本次生成的 `.tmp`、`.bak` 与构建 HTML。内部 `sources.json` 保存在运行目录，不放入上传目录。
10. **更新目录**：更新 `data.json`，用本地通过验收的 PDF 重建 `knowledge/books.json`。
11. **原子提交**：一次提交目录、知识库和运行清单；不得提交临时渲染图或密钥。
12. **部署与冒烟测试**：等待 GitHub 触发的 production 部署，验证首页、详情页和 PDF 链接。
13. **完成**：仅当线上验证通过时标记 `succeeded`。

## 4. 原子性和幂等

- 先本地完成全部质量门，再产生外部写入。
- Blob 先于目录提交。若 Blob 成功但提交失败，允许出现未引用 Blob；不得让 `data.json` 指向不存在或未验证的文件。
- 每个幂等键只允许一条 `succeeded` 记录。重复调用返回已有结果，不重复上传或插入目录。
- 若上次运行停在中间状态，按已保存的校验和恢复；只有输入或产物校验和匹配时才能复用阶段产物。
- `data.json` 更新使用读-校验-生成新文件-结构验证-原子替换的模式；提交前再次检查数组首项和唯一 ID。

## 5. 重试策略

- 网络、Consensus、Blob、GitHub 或部署状态查询的暂时性失败：每阶段最多 2 次重试，指数退避并加入抖动。
- 内容不足、重复选书、事实冲突、PDF 视觉失败：不是原样重试；必须回到相应上游阶段重新选书、重写或重新排版。
- 认证失败、权限不足、缺少环境变量、确定性 schema 错误：不可重试，立即失败。
- 单次运行最多更换 2 次候选书；第三本仍资料不足则结束当天任务，不发布降级稿。

## 6. 运行清单

为每次运行保存机器可读 JSON，至少包含：

```json
{
  "runId": "2026-09-02-daily-book",
  "idempotencyKey": "daily-book:2026-09-02",
  "businessDate": "2026-09-02",
  "timezone": "Asia/Shanghai",
  "status": "succeeded",
  "stage": "verified",
  "attempt": 1,
  "selectedBook": { "title": "", "author": "", "score": 0 },
  "sourceCount": 0,
  "consensusEvidenceCount": 0,
  "pdf": { "pages": 14, "characters": 0, "sha256": "", "url": "" },
  "catalogCommit": "",
  "deploymentUrl": "",
  "acceptance": { "passed": true, "reportPath": "" },
  "startedAt": "",
  "finishedAt": ""
}
```

运行清单不得保存网页全文、访问令牌、Cookie、Authorization 头或模型的隐藏推理。
