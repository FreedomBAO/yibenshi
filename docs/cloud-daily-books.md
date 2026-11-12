# 云端每日精读

目标：电脑关机后，GitHub 托管运行器仍每天执行选书、读取来源、原创写作、14页中文PDF、封面获取、独立审稿和全页视觉审查，全部通过后上传Blob、提交书库、触发Vercel production并实际验收。

## 运行与权限

工作流：`.github/workflows/daily-book.yml`。每天北京时间02:00启动（GitHub调度可能延迟），07:40后不开始发布，08:00后不生成、上传、提交或部署；不自动补跑前一天。重复日期直接no-op。并发组确保同一时刻只有一条发布任务。作者90天冷却，书名/原文名/可用ISBN去重，3本候选按分数选择。资料不足会换候选，不发布降级稿。

此流程是独立云端执行器，不调用本机CLI、桌面Agent、Windows任务或本地队列。旧本地生成任务保持原状；在正式启用云端前，应由用户停用旧链路，避免两个生成端竞争同一天。云端无法在电脑关机时同步本机output，在线验收后的三件套可从GitHub运行产物下载。

## 需要在 GitHub 配置一次

仓库 Settings → Secrets and variables → Actions → Repository secrets：

| 名称 | 用途 |
| --- | --- |
| `DEEPSEEK_API_KEY` | 普通开放平台API、有余额；不使用Coding Plan专用Key |
| `BLOB_READ_WRITE_TOKEN` | 现有网站的public Blob存储凭据 |
| `VERCEL_DEPLOY_HOOK` | Vercel项目 Settings → Git → Deploy Hooks，指向main |

工作流的GitHub写权限使用短期`GITHUB_TOKEN`自动提供，不必再创建永久PAT。仓库需允许Actions写Contents；若有main保护规则，先解决自动提交授权，不能绕过保护。

Repository variables：

- `ENABLE_DAILY_BOOKS=true`：开启每天自动运行；未设置时定时任务不执行。
- `DAILY_BOOK_MAX_USD=0.50`：每次运行的模型请求预算保护值（美元）。按官方Flash峰值费率和最大输出预留，成功与超时均计入预留；不等于实际账单，也不是平台侧硬扣费上限。费率变化时应更新代码。另设提供商控制台消费告警/额度。30次运行的默认模型预算预留合计15美元，实际通常低于预留；Blob、网络、GitHub产物存储和线上伴读验收的单次调用另算。

GitHub公开仓库的标准托管运行器计算时长免费，产物存储受账户额度和保留时间约束。程序通过DeepSeek普通API调用文本、搜索、Fetch和视觉模型；不需要为此购买四家模型订阅。调用前检查配置，不在日志记录密钥、请求头、完整供应商异常或Base64。

## 首次启用顺序

1. 合并代码到main，并先配置上述3个Secrets，暂不设置启用变量。
2. 在北京时间02:00-07:40，从Actions → Daily book cloud pipeline → Run workflow执行，`publish`保持false。查看产物：正文、来源映射、PDF、封面、每页视觉报告、acceptance.json及usage.json。此步骤会调用付费API，但不会上传发布。
3. 确认模型权限、来源、字体和封面都正常后，再手动执行`publish=true`，完成一次生产验收。
4. 停用原来的本地生成/审查定时链路，再设置`ENABLE_DAILY_BOOKS=true`。这一步只配置一次，之后每本书通过审核直接发布。

未配置Secrets的代码测试不等于已完成云端上线。失败的工作流会显示红色，可通过GitHub账户Actions通知接收提醒；失败报告保留14天。搜集到的网页正文仅在临时运行器中参与研究，不上传到运行产物，sources.json只留来源元数据与主张映射。

## 审核和发布边界

- Pydantic检查结构；来源必须来自实际搜索结果并Fetch成功；至少5来源、2第一方。
- 写作与独立审稿分开调用；所有事实案例和主张映射来源。模型仍可能误判，自动审核不是事实正确性的保证。
- 14页确定性ReportLab版式，嵌入中文字体，10.5pt正文/15.5pt行距/20mm边距；溢出直接失败，禁止静默截断或缩小字号。
- pypdf提取中文，PyMuPDF渲染14页，每页单独视觉复审；封面独立视觉复审，最短边600像素。
- 封面优先出版社或作者官方版本，有来源与使用依据；无法核实使用依据、匹配或清晰度时停止。
- `acceptance.prepublishPassed`仅代表生成验收；`passed`在生产首页、书库、目录/知识库字节哈希、PDF/封面、真实RAG请求均通过后才为true。
- PDF和封面上传后按字节哈希复核。目录与知识库同一次提交；知识库只增量构建新书，历史条目保留。
- 网页读取同一次部署的data.json，不抢先读取GitHub主分支，避免目录先于生产资源更新。
- 生产失败仅revert本次发布提交；若main已被其他人更新或已过08:00，停止自动回滚并留下失败运行，不force push。部署失败可能留下未引用Blob，不删除历史正式文件。

## 本地离线验证

安装 `tools/cloud_daily/requirements.txt`，Linux安装`fonts-wqy-zenhei`，或设置`DAILY_BOOK_FONT`指向可嵌入中文TTF/TTC。

```text
python -m unittest discover -s tests -p test_cloud_daily.py
python -m tools.cloud_daily.selfcheck
```

离线样稿有fixture标记，明确不能上传发布。正式预演需要真实DeepSeek Key和当日时间窗口。

官方依据：

- https://api-docs.deepseek.com/quick_start/pricing/
- https://api-docs.deepseek.com/guides/search/
- https://api-docs.deepseek.com/guides/vision/
- https://docs.github.com/en/actions/concepts/billing-and-usage
- https://vercel.com/docs/deploy-hooks
