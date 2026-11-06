# 阶段 2 交付报告：商品图评审接入

日期：2026-11-05
阶段：P2（商品图评审），对应 `docs/ai-development/STAGE-PROMPTS.md` 阶段 2。
基准：分支 `feat/commerce-commercialization`；工作区原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段只改了 `frontend/workbench.js`）。
真实服务验收：**无**。没有配置真实多模态端点，没有真实样本、真实模型输出或人工对照验收；所有"看图"结论在真实环境中仍为 `unknown`。

## 1. 本阶段做了什么

新增 `src/visual-review.mjs`，把 `commerce-image-reviewer` Skill 从"文档"变成可调用的评审能力，但仍然只评审、不修订。

| 能力 | 实现 | 说明 |
|---|---|---|
| 规则装配 | `loadReviewerRules()` | 读取 `runtime/reviewer-system.md`、`skills/commerce-image-reviewer/SKILL.md`、`references/checklist.md` 与输出 Schema；生成 `rules_hash`，规则变化后旧报告不可复用 |
| 请求绑定 | `buildReviewRequest()` | 冻结 `context_hash`、`artifact_version_id`、`artifact_hash`；候选图必须真实附带；主体/包装/细节作为参考图；**风格图不附带**，避免冒充商品身份依据 |
| 最小多模态 Adapter | `createVisualReviewer()` / `createVisualReviewerFromEnv()` | `POST` 到 `QTB_VISUAL_REVIEW_ENDPOINT`，图片以 base64 发送；超时、HTTP 错误、非 JSON、网络异常全部归类为明确状态，不抛出到生成流程 |
| 结构/语义校验 | `reviewArtifact()` + `validateReviewOutput()` | 校验 Schema、Skill 版本、上下文/成品哈希、图片绑定、参考图只能引用已附带图片、八项检查齐全、未知必须写原因 |
| 报告映射 | `visualReviewChecks()` | 输出 `REVIEW_*` 八项，追加到现有报告；关键商品项 `required + hard_gate`，不接受模型 `not_applicable` 绕过 |
| 追加而不覆盖 | `attachVisualReview()` | 保留原 `checks` 与证据，合并后重算 `decision` / `decision_reasons`；新增 `report.visual_review` 元数据 |
| 前端展示 | `frontend/workbench.js` | QA 区块显示"视觉评审"状态、模型、耗时、未知原因与追加项数量；检查项显示 `reasons`；明确"不会自动修改图片" |

接入点：

- `src/jobs.mjs`：`createJobs` 新增可注入 `visualReviewer`；仅在已配置时，在 `evaluateAttemptQuality` 中追加评审；评审失败只影响新增项，不让生成失败。
- `src/api.mjs` / `src/server.mjs`：支持构造注入，也支持环境变量；`GET /api/provider/capabilities` 返回 `visual_review.configured/mode/acceptance`。
- `src/m07.mjs` 未改动；新检查以追加方式进入报告，原始证据不变。

## 2. 环境变量与降级语义

| 变量 | 作用 |
|---|---|
| `QTB_VISUAL_REVIEW_ENDPOINT` | 未设置即"未配置"，报告不追加 `visual_review`，也不伪造看图结论 |
| `QTB_VISUAL_REVIEW_API_KEY` | 可选的 Bearer Token |
| `QTB_VISUAL_REVIEW_MODEL` | 请求中的模型标识 |
| `QTB_VISUAL_REVIEW_TIMEOUT_MS` | 调用超时，默认 20s |

降级状态：`not_configured`、`unavailable`、`timeout`、`error`、`http_error`、`invalid_json`、`invalid_output`。任一失败都会让八项评审变为 `unknown`，并写明原因；不会出现"模型没看图却给 pass"。

## 3. 验收场景与证据

| 场景 | 测试 | 结论 |
|---|---|---|
| 缺图 | `P2 缺图与不可读候选` | 不发起模型调用，八项 `unknown` |
| 图片不可读 | 同上（候选无字节） | 同上，明确 `CANDIDATE_NOT_ATTACHED` |
| 无效 JSON | `P2 调用超时与非法 JSON` | `invalid_json`，八项 `unknown` |
| 错误哈希 | `P2 错误哈希与缺检查项` | `BINDING_MISMATCH`，整体 `unknown` |
| 缺检查项 | 同上 | `MISSING_CHECK`，整体 `unknown` |
| 跨租户 | `P2 HTTP：能力端点与租户隔离` | 其他租户访问项目 404 |
| 注入 | `P2 注入防护` | 商家文案只进入 `user` 数据字段，不进入 system 规则 |
| 超时 | `P2 外部端点超时` | Adapter 归类 `timeout`，不抛出 |
| 旧报告失效 | `P2 旧报告失效` | 事实或规格版本变化 → `stale` |
| 关键项 not_applicable | `P2 关键项不适用` | 五项商品关键检查转 `unknown`，不能绕过 |
| 任务接入 | `P2 任务接入` | 已配置时报告追加八项；未配置时报告完全没有 `visual_review` 与 `REVIEW_*` |
| 追加不覆盖 | `P2 检查映射` | 原 `FILE_INTEGRITY` 证据保持原样；关键项 fail → `blocked` |

## 4. 验证结果

环境：Node `v22.22.2`。

| 命令 | 结果 |
|---|---|
| `node scripts/check.mjs` | 98 个文件语法通过 |
| `node test/ai03.js` | 13 通过 / 0 失败 |
| 回归 `node test/m05.js` / `m07.js` / `r04.js` | 全部通过 |
| 全量 `npm test` | 334 项，333 通过 / 0 失败 / 1 跳过，约 256 秒 |

全量测试日志：`runtime/stage2-npm-test.log`。日志内无 `not ok` 行；唯一跳过项为既有用例，与阶段 2 改动无关。

## 5. 仍未验收与边界

- **真实视觉评审未验收**：没有真实多模态端点、没有真实样本，也没有人工对照。阶段任务要求的"真实样本人工对照"未执行，不能声称评审准确率、漏检率或误检率。
- **规则文字不是看图结论**：未配置端点时不追加评审项；配置端点但调用失败时全部 `unknown`。
- **只评审不修订**：本阶段没有调用 `commerce-image-refiner`，没有自动改图或自动重生成。
- **追加项与旧检查并存**：`VISUAL_QUALITY`（m07 原有）与新 `REVIEW_*` 是两类不同证据，前者保持 unknown，后者只在接入后出现。
- **规范差异**：`RUNTIME-CONTRACT.md` 要求"商品关键视觉项首版默认 required 且 hard_gate"已落实；但未接入模型的部署不会因此永久 `needs_review`，这是刻意选择，已在能力端点明确显示未配置。

## 6. 下一阶段入口（P3 商品图修订）

按 `STAGE-PROMPTS.md` 阶段 3：接入 `commerce-image-refiner`，把评审 `fail` 转成受控修订指令，复用现有 revision/version/预算系统，限制轮数与无改善终止；真实模型效果继续标"未验收"。
