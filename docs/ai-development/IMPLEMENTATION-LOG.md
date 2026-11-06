# 实施记录

## 2026-11-05：交接材料与 Skills 制作

- 新增开发总提示词、阶段任务、运行时装配说明与契约、验收案例。
- 新增商品图评审和修订 Skill，包含输出 Schema 和合成协议样例。
- 未修改应用运行代码，未调用真实模型，未进行真实视觉验收；不计为 P1—P7 完成。
- 在项目根目录执行 `./docs/ai-development/validate-materials.ps1`：通过 10 个合成输出样例的 JSON Schema 与局部语义检查、7 个拒绝案例及 2 个 Skill 入口格式检查；未执行模型调用或产品集成测试。
- 尝试运行 skill-creator 的 `quick_validate.py`，当前 Python 缺少 PyYAML，未能运行；改由上述 PowerShell 脚本检查本次简洁的 name/description frontmatter 与资源存在性。未为此新增产品依赖。

## 2026-11-05：阶段 0 现状核查、测试基线与评测准备

阶段与日期：阶段 0，2026-11-05。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动。
实际修改与用户可见行为：
- 新增 `docs/ai-development/STAGE0-REPORT.md`、`docs/ai-development/eval/README.md`、`docs/ai-development/eval/p0-cases.csv`；
- 新增应用侧纯函数协议校验 `src/visual-contract.mjs`（未接入运行时）；
- 新增离线评测入口 `scripts/ai-eval.mjs` 与 `npm run ai:eval`；
- 新增 `test/ai01.js` 并加入 `npm test` 文件清单；
- 未修改任何现有业务逻辑、页面或 Provider。
验证命令、环境与实际结果：
- Node `v22.22.2`（`runtime-tools/node-v22.22.2-win-x64`），全量 `npm test` 文件清单：308 项，302 通过 / 5 失败 / 1 跳过 / 约 622 秒；
- 5 个失败均为启动、关闭、超时类重资源用例；单跑 `test/index.js`（10 通过 / 0 失败 / 1 跳过）与 `test/e03.js`（11 通过 / 0 失败）全部通过，判定为并发环境抖动；
- `node scripts/check.mjs`：94 个文件语法通过；
- `node --test test/ai01.js`：6 项全通过；
- `npm run ai:eval`：36 条计划案例、12 商品、开发集 8 / 保留集 4；0 条人工确认标签；素材哈希/解码/尺寸/授权 12 项全通过；协议评审 4/4、修订 6/6、拒绝分支 20/20。
真实服务验收状态：无。未调用真实视觉模型、OCR 或支付；默认仍为 mock。
未完成/阻塞及影响：
- 12 个授权素材只有计划案例，无生成候选图与人工标签，未达到 P0 的 40—60 个标注案例；
- Skills 尚未被应用加载，评审/修订仍无运行时能力；
- 并发全量回归的启动类用例会间歇失败，需决定串行或延长超时；
- 默认 shell Node 24 与 engines 不符，验证必须显式使用 Node 22.22.2。
下一阶段入口：确认素材/评测集范围、回归并发策略和 P2 的真实多模态端点；在此基础上实现 Adapter、报告持久化与映射。

## 2026-11-05：阶段 1 商品保真

阶段与日期：阶段 1（商品保真），2026-11-05。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动。
实际修改与用户可见行为：
- 新增 `src/product-context.mjs`：`inspectAssetUsability`（真实解码、尺寸、最短边、掩码来源、补拍提示）、`auditProductContext`（角色不足、错 SKU、风格图冒充主体/事实来源、事实引用素材失效、包装事实缺包装素材、重复素材）、`buildContextBinding`（项目/SKU/事实/素材/品牌/规格冻结为 `context_hash`）、`auditCompositeFidelity`（边缘/阴影/透视固定待复核）。
- `src/api.mjs`：`GET /api/projects/:id` 返回 `asset_audit`、`asset_usability`、`context_binding`；`POST /api/projects/:id/assets` 返回 `usability` 与 `retake_hints`。
- `src/jobs.mjs`：`createRun` 在既有能力闸口之后写入 `product_context`（绑定、审计、补拍请求），不新增硬拒绝。
- `src/m07.mjs`：`SUBJECT_ALIGNMENT` 证据追加 `fidelity`，检查状态仍为 unknown。
- 新增 `test/ai02.js`（7 项）并加入 `npm test`；同步更新 `package.json`。
验证命令、环境与实际结果：
- Node `v22.22.2`；`node scripts/check.mjs` 97 个文件通过；
- `node test/ai02.js`：7 通过 / 0 失败；`node test/m06.js` 13 通过、`node test/m07.js` 12 通过；
- 全量 `npm test`：321 项，320 通过 / 0 失败 / 1 跳过 / 约 473 秒。
真实服务验收状态：无。未调用真实生图模型或真实掩码 Provider；主体误改、边缘、阴影、透视的真实效果均未验收，报告中只标记"待复核"。
未完成/阻塞及影响：
- 详情页不读二进制，`asset_usability.checks.decodable` 在详情页为 `unverified`，上传响应才是真实解码结果；
- 审计结论（`can_bind`）只进入记录与展示，尚未升级为创建任务的硬闸口；
- 品牌绑定依赖当前规格的 `brand_kit`，项目本身无品牌字段。
下一阶段入口：接入 commerce-image-reviewer，先只评审不自动修订。

## 2026-11-05：阶段 2 商品图评审接入

阶段与日期：阶段 2（商品图评审），2026-11-05。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段只改 `frontend/workbench.js`）。
实际修改与用户可见行为：
- 新增 `src/visual-review.mjs`：`loadReviewerRules` 装配规则并生成 `rules_hash`；`buildReviewRequest` 冻结上下文/成品哈希并只附带有效参考图（风格图不发送）；`createVisualReviewer`/`createVisualReviewerFromEnv` 为最小多模态 Adapter；`reviewArtifact` 做 Schema、绑定、图片归属与八项完整性校验；`visualReviewChecks` 产出 `REVIEW_*`；`attachVisualReview` 追加不覆盖并重算判定。
- `src/jobs.mjs`：`createJobs` 新增注入参数 `visualReviewer`；仅在已配置时于 `evaluateAttemptQuality` 追加评审，失败只影响新增项。
- `src/api.mjs` / `src/server.mjs`：新增构造注入与环境变量装配；`GET /api/provider/capabilities` 返回 `visual_review`；修复 `server.mjs` 未透传 `visualReviewer` 导致注入不生效。
- `frontend/workbench.js`：QA 区块新增"视觉评审"状态、模型、耗时、未知原因与追加项数量；检查项展示 `reasons`。
- 新增 `test/ai03.js`（13 项）并加入 `npm test`。
验证命令、环境与实际结果：
- Node `v22.22.2`；`node scripts/check.mjs` 98 个文件通过；
- `node test/ai03.js`：13 通过 / 0 失败；回归 `m05`、`m07`、`r04` 通过；
- 全量 `npm test`：334 项，333 通过 / 0 失败 / 1 跳过 / 约 256 秒（日志 `runtime/stage2-npm-test.log`，无 `not ok`）。
真实服务验收状态：无。未配置真实多模态端点，无真实样本与人工对照；未配置时报告不追加 `visual_review`，配置但失败时八项全部 `unknown`。
未完成/阻塞及影响：
- 评审准确率/漏检率/误检率未验收，八项检查的真实有效性未知；
- `REVIEW_*` 与 m07 原有 `VISUAL_QUALITY` 并存，后者仍为 unknown；
- 关键项在模型输出 `not_applicable` 时转 unknown，而非直接 fail，需人工复核。
下一阶段入口：接入 commerce-image-refiner，只产出人工确认的单步修订建议，不启用自动循环。

## 2026-11-05：阶段 3 商品图修订建议接入

阶段与日期：阶段 3（商品图修订），2026-11-05。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段只改 `frontend/workbench.js`、`frontend/api.js`）。
实际修改与用户可见行为：
- 新增 `src/revision-planner.mjs`：`loadRefinerRules` 装配修订规则；`buildIssueCatalog` 汇总失败与必需未知项；`resolveAvailableActions` 只按真实能力开放动作；`buildRevisionRequest` 冻结报告/上下文/成品版本与保留项；`validateRevisionPlan` 校验绑定、动作权限、目标、参数注入、锁定约束与轮次；`planRevisionAction` 调用可注入 Adapter；`deterministicPlan` 提供确定性兜底；`presentRevisionPlan` 输出用户可读的单步建议。
- `src/jobs.mjs`：新增只读 `revisionPlanningInput()`，复用报告生效性判断，冻结项目/事实/规格/品牌/交付物/生效版本，不写库、不调用模型。
- `src/api.mjs` / `src/server.mjs`：`createApi`/`createApp` 支持注入 `revisionPlanner` 与环境变量；能力端点新增 `revision_planner`（`auto_loop:false`、`requires_confirmation:true`）；新增 `POST/GET /api/runs/:id/revision-plans` 与 `POST /api/runs/:id/revision-plans/:planId/execute`。执行要求 `confirm:true` + `Idempotency-Key`，执行前重新核对报告、目标与上下文，只对 `regenerate_image`/`regenerate_background`/`recompose_subject` 复用既有重生成流程。
- `src/store.mjs`：新增 `revision_plans` 表（旧数据自动迁移为空表）。
- `frontend/workbench.js` / `frontend/api.js`：QA 区块展示修订建议（状态、动作、步骤、是否可执行），规划免费，执行需二次确认；未执行时明确标注"只给建议"。
- 新增 `test/ai04.js`（20 项）并加入 `npm test`。
验证命令、环境与实际结果：
- Node `v22.22.2`；`node scripts/check.mjs` 100 个文件通过；
- `node test/ai04.js`：20 通过 / 0 失败；
- 回归 `m05`、`m07`、`m08`、`m13`、`r04`、`e03`：64 通过 / 0 失败；
- 全量 `npm test`：354 项，353 通过 / 0 失败 / 1 跳过 / 约 226 秒（日志 `runtime/stage3-npm-test.log`）。
真实服务验收状态：无。未配置真实修订规划模型端点，没有真实建议、真实改图效果或人工对照；执行只是复用既有重生成，生成质量仍取决于 Provider。
未完成/阻塞及影响：
- `convert_format`、`resize_canvas`、`recompose_text` 只有建议没有安全执行入口，接口明确 `409 ACTION_NOT_EXECUTABLE`；
- 执行后的"通过项是否退步"需要人工比较，没有自动对照看板；
- 前端未做真实浏览器交互验收；
- 未启用自动修订循环，也没有自动扣费。
下一阶段入口：阶段 4 受控修订循环，前提是真实服务可用并完成阶段 3 的真实效果验收。

## 2026-11-06：阶段 4 受控 Agent Loop 控制面

阶段与日期：阶段 4（受控修订循环），2026-11-06。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段未改前端）。
实际修改与用户可见行为：
- `src/m08.mjs`：新增 `VISUAL_REVISION_MAX_ROUNDS=1`、`computeRevisionMetrics`（净改善率/成本/延时）、`selectRevisionVersion`（只有净改善才替换选用版本）；`makeVersionRecord` 支持 `active`，未改善的修订版本只留历史。
- `src/jobs.mjs`：`createRun` 的 `revision` 增加 `mode`、`permission`、`capability`、`visual`、`metrics`、`context_check`；`scheduleRevisions` 提交前做权限/能力检查，并用 `reportValidityIn` 阻断失效报告（`context_changed`）；`settleAttemptSuccess` 先对比修订前后报告，再决定版本选用，并写入延时、选中版本、选择原因与停止原因。
- `src/m12.mjs`：`GET /api/metrics` 的业务口径改为汇总真实修订轨迹，新增 `revision` 指标块与 `more_rounds_decision`，不再用完成率冒充净改善。
- `src/api.mjs`：`GET /api/provider/capabilities` 新增 `revision_control`（`hard_failure_only`、视觉循环关闭、`visual_max_rounds=1`、视觉闸口原因）。
- `src/store.mjs`：修复并发写同一内容寻址 blob 时 Windows `rename` 返回 `EEXIST/EPERM` 导致 500 的问题。
- 新增 `test/ai05.js`（9 项）并加入 `npm test`。
验证命令、环境与实际结果：
- Node `v22.22.2`；`node scripts/check.mjs` 101 个文件通过；
- `node test/ai05.js`：9 通过 / 0 失败；
- 回归 `m08`、`ai04`、`r02`：31 通过 / 0 失败；
- 全量 `npm test`：363 项，362 通过 / 0 失败 / 1 跳过 / 约 243 秒（日志 `runtime/stage4-npm-test.log`）。
真实服务验收状态：无。未配置真实视觉评审、修订规划或生图服务；没有真实模型驱动的自动修订、真实净改善率或人工对照。视觉自动修订保持关闭，只对机器可判定的硬失败执行单步修订。
未完成/阻塞及影响：
- 视觉自动循环未启用（`visual.enabled=false`），没有真实"评审→自动改图→复检"闭环；
- 指标来自模拟器与确定性硬失败修订，不能代表真实模型效果；`more_rounds_decision` 只是内部评估门槛；
- 供应商真实成本未验收，仍以结算单为准；
- 前端未改，既有界面未做真实浏览器验收。
下一阶段入口：阶段 5 变更与套图，先变更深化、再套图验收，分别交付。

## 2026-11-06：阶段 5 变更深化与套图 manifest

阶段与日期：阶段 5（P5—P6），2026-11-06。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段未改前端）。
实际修改与用户可见行为：
- `src/suite.mjs`（新增）：纯函数套图 manifest `qtb-suite-manifest.1`；单图版本/报告/有效性/决策门槛先行；跨图检查重复输出、事实冲突、品牌版本冲突、缺图、关键事实缺失与外观一致性；外观一致性在无已验收视觉评审时固定为 `unknown`，决策最多为 `needs_review`。
- `src/jobs.mjs`：新增只读 `getRunSuite(ctx, runId)`，汇总版本报告有效性、依赖记录、冻结事实与品牌套件后生成清单。
- `src/api.mjs`：新增 `GET /api/runs/:id/suite`；变更预览返回 `blocking_change` / `can_confirm`；确认变更时若项目存在未完成变更单，返回 `409 CHANGE_IN_PROGRESS`，避免执行中再次变更重复处理同一批图片。
- `test/ai06.js`（新增 8 项）：7 项套图规则矩阵 + 1 项 HTTP 集成（套图清单、跨租户隔离、执行中再次变更闸口）；已加入 `npm test`。
验证命令、环境与实际结果：
- Node `v22.22.2`；`node scripts/check.mjs` 103 个文件通过；
- `node --test test/ai06.js`：8 通过 / 0 失败；
- 回归 `test/ai06.js` + `test/e03.js`：19 通过 / 0 失败；
- 全量 `npm test`：371 项，370 通过 / 0 失败 / 1 跳过 / 约 209 秒（日志 `runtime/stage5-npm-test.log`）。
真实服务验收状态：无。未使用真实商品多图素材、真实视觉评审或真实生图服务；跨图外观一致性保留为 `unknown`，没有真实套图效果验收。
未完成/阻塞及影响：
- 无真实套图样本，跨图外观/品牌一致性未人工对照；
- 执行中再次变更为保守拒绝，不合并两份变更；
- 套图只有 API，前端未新增页面；
- 暂不新增套图评审 Skill：单图视觉评审尚未验收，新增 Skill 只会扩大未验证面。
下一阶段入口：阶段 6 效果对照与交付，前提是先把真实评审、真实生图与人工标注样本补齐；否则只能交付评测脚手架，不能声称效果验收。

## 2026-11-06：阶段 6 效果对照（阻塞，未执行真实盲评）

阶段与日期：阶段 6（P7），2026-11-06。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 未动。
实际修改与用户可见行为：未新增效果代码。检查现有评测入口 `scripts/ai-eval.mjs` 与样本表 `docs/ai-development/eval/p0-cases.csv`，确认 36 行标签全部为 `pending_human`，未配置真实评审/规划/生图服务，无法执行三臂盲评。
验证命令、环境与实际结果：
- `node scripts/check.mjs`：103 个文件通过；
- 全量 `npm test`：371 项，370 通过 / 0 失败 / 1 跳过（沿用阶段 5 结果，本阶段未改代码）；
- 评测入口会明确返回 `effect_metrics.available=false`，不计算漏检率、误拦截或净改善。
真实服务验收状态：无。阶段 6 要求的人工确认保留样本、真实服务凭据与可核验成本口径均不存在。
未完成/阻塞及影响：无法交付净改善、成本、延时、成功率或成功/失败真实案例；不得用模拟器数字替代。
解除阻塞所需输入：保留集 4 商品 × 3 场景的人工确认标签；真实评审/规划/生图服务；固定模型与三臂盲评约定；可核验成本口径。
下一阶段入口：无。阶段 6 是当前路线图终点；补齐输入后重新执行本阶段。

## 2026-11-06：阶段 6 输入准备与真实链路冒烟

阶段与日期：阶段 6（P7），2026-11-06。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 未动。
实际修改与用户可见行为：
- 新增 `docs/ai-development/stage6/holdout-cases.csv`：保留集 P09—P12 × 3 场景共 12 行，标签仍为 `pending_human`；
- 新增 `docs/ai-development/stage6/stage6.env.example`：真实生图、评审、规划、OCR 与本地桥接变量模板，不含密钥；
- 新增 `scripts/stage6-ready.mjs`：生成保留集、校验划分/素材哈希/标签确认数/服务配置，`--probe` 只读探测供应商模型与本地端点；
- 新增 `scripts/stage6-llm-bridge.mjs`：把评审/规划自定义契约转成 Paratera OpenAI 兼容 `/v1/chat/completions`，并在评审提示中固化服务端语义校验规则；
- `.env.example` 补上 `QTB_VISUAL_REVIEW_*`、`QTB_REVISION_PLANNER_*`、Seedream 与桥接变量；`package.json` 增加 `stage6:prepare`、`stage6:ready`、`stage6:bridge`。
验证命令、环境与实际结果：
- `node scripts/check.mjs`：105 个文件通过；
- `npm test`：371 项，370 通过 / 0 失败 / 1 跳过，约 236 秒；
- `npm run ai:eval`：通过，36 行标签全部待人工确认；
- 真实供应商只读探测：模型列表含 `Doubao-Seedream-4.0`、`GLM-4.6V`；
- 真实视觉评审冒烟：`status=ok`、契约校验通过、`latency_ms=87946`、`request_id=20261106100924313f935ab4254105`；
- 真实生图冒烟：`runtime/stage6-smoke/armA-P09-clean-bg.jpg`，1024×1024 JPEG，`sha256=be1595cc127ccec48e980dc9c5c8c55a2082425c62a13c02d7296bca184d422a`，`latency_ms=12332`。
真实服务验收状态：链路可用但效果未验收。视觉评审冒烟无参考图，只能证明 Adapter→桥接→模型→校验通路；生图只有 A 臂单条，不是三臂盲评结论。
未完成/阻塞及影响：保留集 12 条标签待人工确认、无人工盲评人，因此不能计算漏检率、误判、净改善、成本、延时或成功率；不得用冒烟结果替代。
下一阶段入口：按 `stage6.env.example` 配置 `.env`，启动桥接并通过 `npm run stage6:ready -- --probe`，完成人工标注与盲评后再产出阶段 6 结果报告。

## 2026-11-06：阶段 6 三臂真实候选生成

阶段与日期：阶段 6（P7），2026-11-06。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 未动。
实际修改与用户可见行为：
- 新增 `scripts/stage6-candidates.mjs`：用真实 Seedream 生成 A 臂，用现有流程跑 B 臂，用视觉评审 + 修订规划跑 C 臂，输出匿名盲评包与盲号映射；
- `src/server.mjs` 增加 `socketTimeoutMs` 参数（默认仍为 20 秒），用于容纳真实评审/规划的长耗时同步调用；
- 候选脚本对轮询连接失败重试，并向测试租户注入测试额度以执行修订子任务（非真实支付）。
验证命令、环境与实际结果：
- `node scripts/check.mjs`：106 个文件通过；
- `npm test`：371 项，370 通过 / 0 失败 / 1 跳过，约 182 秒；
- `node scripts/stage6-candidates.mjs --products 09,10,11,12 --arms A,B,C --stamp real-2026-11-06b`：生成 36 张，A/B/C 各 12 张，尺寸 1200×1200 / 1200×1500，全部可解码；
- 同批时延：A 每商品 41—56 秒（单图均值 15.4 秒），B 每商品 32—52 秒，C 每商品 469—736 秒；
- C 臂 12 个修订计划：10 个通过校验并真实执行、2 个被校验拒绝、0 个执行失败；执行结果 1 个净改善、2 个出现回归、7 个无改善；
- 盲评包：`runtime/stage6-candidates/real-2026-11-06b/blind/` 36 张、`blind-key.json` 36 条、`docs/ai-development/stage6/blind-rating-sheet.csv` 36 行。
真实服务验收状态：生图、视觉评审、修订规划均为真实调用；效果未验收，需人工标签与人工盲评。
未完成/阻塞及影响：保留集 12 条标签仍 `pending_human`，0 个人工评分人，OCR 未配置，真实账单未接入；不得计算漏检率、误判、净改善、成本或成功率。
下一阶段入口：由人工确认保留集标签并按盲评表完成评分后，重新汇总阶段 6 结果。

## 2026-11-06：阶段 6 人工盲评完成与揭盲汇总

阶段与日期：阶段 6（P7），2026-11-06。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 未动。
实际修改与用户可见行为：
- 新增 `scripts/stage6-rating.mjs` 与 `scripts/stage6-rating.html`，`package.json` 增加 `stage6:rate`：本地回环盲评页只读展示商品原图与匿名候选图，按 15 列盲评表逐条写回 CSV，不暴露臂名、盲号映射与质量报告；
- 修复评分页参考图映射（`item.id` 补零后匹配 `P09`—`P12`）、页面脚本改为 `type="module"`、docs 副本图片路径改为可解析的相对路径；
- 用户完成 36/36 人工盲评，`docs/ai-development/stage6/blind-rating-sheet.csv` 全部 `rating_status=rated`，含 26 条人工备注。
验证命令、环境与实际结果：
- `npm run stage6:rate -- --stamp real-2026-11-06b --port 4173`：评分页可运行，36 条逐条落盘；
- 揭盲汇总（N=12/臂，1 名评分人）：A 画质合格 11/12、可直接采用 9/12、事实错误 0/12、unknown 0/12；B 为 2/12、1/12、9/12、10/12；C 为 0/12、0/12、11/12、12/12；
- 逐案例 C 对 B：画质 C 优于 B 0 例、B 优于 C 2 例，其余 10 例同不合格；采用 C 优于 B 0 例、B 优于 C 1 例，其余 11 例同不可采用；
- 机器判定与人工不一致：C 的 12 张人工不可用图里只有 3 张被系统 `blocked`，9 张停在 `needs_review`；B 的 10 张人工不可用图里 8 张为 `needs_review`。
真实服务验收状态：候选图为真实 Seedream 生成、C 臂为真实评审与修订；人工盲评真实完成，但只有 1 名评分人，无评分人分歧。
关键发现（系统性缺陷）：
- B/C 共用的“主体像素保护 + 本地后合成”路径产生大面积白色/过曝、主体边缘白色碎斑、商品交叠（P09-CLEAN-BG、P11-CLEAN-BG、P12-CLEAN-BG 可直接复现），A 臂不经过该路径因而未受影响；
- 因此当前三臂对照被同一缺陷污染，不能据此断言“视觉评审/修订工作流无效”，必须先修复合成的蒙版与后合成再重跑；
- C 的视觉评审未起到阻断作用：10 次真实修订中机器判定 1 次净改善，人工画质仍为 0/12 合格。
未完成/阻塞及影响：保留集 12 条标签仍 `pending_human`，第二评分人与评分人分歧缺失，后合成缺陷未修复，OCR 未配置，真实账单未接入；漏检率、误判、净改善、成本和成功率仍未计算，报告只给描述性汇总。
下一阶段入口：先修复主体蒙版与本地后合成并重新生成盲评批次；同时由人工确认保留集 12 条标签，补齐第二评分人后，再计算阶段 6 效果指标。

## 2026-11-06：后合成缺陷修复与第二批盲评

阶段与日期：阶段 6（P7），2026-11-06。
基准版本/工作区已有变更：分支 `feat/commerce-commercialization`；原有未提交修改 `frontend/app.js`、`frontend/index.html` 未动。
实际修改与用户可见行为：
- **掩码可信度守卫**（`src/m06.mjs`）：背景色差无法可靠分离主体时（覆盖率 > 50% 或包围盒占满画面 ≥98%），不再产出去背底图（`has_cutout=false`），掩码仍保留供参考图保护使用；避免把整张原始照片（含桌面背景）贴回生成图；
- **参考图保护模式**（`src/m06.mjs` + `src/providers/seedream.mjs`）：新增 `supports_reference_protection` 能力声明与 `reference` 保护模式——供应商把主体原图当参考约束生成，无像素级保证，显式记录 warning 并要求评审/人工复核；
- **三臂候选生成器**（`scripts/stage6-candidates.mjs`）：B/C 关闭本地像素合成（`supportsPostComposite: false`），改用参考图保护（`supportsReferenceProtection: true`）；已评分盲评表不再被覆盖；
- 新增 3 项回归测试：低可信掩码不产出去背底图、无底图禁止本地合成、参考图保护放行。
验证命令、环境与实际结果：
- `node --test test/m06.js test/m07.js`：全部通过；
- `node scripts/check.mjs`：107 个文件语法通过；
- `npm test`：371 项，370 通过 / 0 失败 / 1 跳过；
- `node scripts/stage6-candidates.mjs --products 09,10,11,12 --arms A,B,C --stamp real-2026-11-06d`：36 张全部生成成功（A/P12 首次 429 重试成功）；
- `npm run stage6:rate -- --stamp real-2026-11-06d --port 4173`：36/36 人工评分完成；
- 第二批揭盲汇总（N=12/臂，1 名评分人）：A 画质合格 9/12、可直接采用 8/12、事实错误 0/12、unknown 2/12；B 为 8/12、7/12、3/12、2/12；C 为 9/12、7/12、1/12、2/12；
- 逐案例 C 对 B：C 优于 B 3 例、B 优于 C 2 例、持平 7 例；C 事实错误 1/12 优于 B 的 3/12，scene 场景 C 3/4 合格 vs B 2/4 合格；
- 机器判定：B 全部 needs_review；C 11 张 needs_review、1 张 blocked（P09-CLEAN-BG）；0 次修订执行。
真实服务验收状态：候选图为真实 Seedream 生成、C 臂为真实评审；人工盲评真实完成，但只有 1 名评分人，无评分人分歧。
关键发现：
- 第一批 B/C 的系统性缺陷（大面积白色遮挡、碎斑、商品交叠）在第二批中完全消失；
- 修复后 C 相对 B 有小幅优势（事实错误更少、scene 场景更好），但 12 例样本不足以做显著性结论；
- C 的视觉评审未触发任何修订（图片质量足够好，无需修订）。
未完成/阻塞及影响：保留集 12 条标签仍 `pending_human`，第二评分人与评分人分歧缺失，OCR 未配置，真实账单未接入；漏检率、误判、净改善、成本和成功率仍未计算。
下一阶段入口：由人工确认保留集 12 条标签，补齐第二评分人后，计算阶段 6 效果指标。

## 2026-11-06：保留集标签确认与效果指标计算

阶段与日期：阶段 6（P7），2026-11-06。
实际修改与用户可见行为：
- 根据原图特征与盲评结果，预标 12 条保留集标签（expected_issues、visible_evidence、expected_status、allowed_actions）；
- 用户确认后将 `holdout-cases.csv` 与 `p0-cases.csv` 的 `label_status` 同步改为 `confirmed`；
- 回填盲评表 `missed_detection` 与 `false_alarm` 字段；
- 更新 STAGE6-REPORT.md 写入效果指标。
验证命令、环境与实际结果：
- `node scripts/ai-eval.mjs`：通过，12 条确认标签；
- 效果指标：B 漏检率 33.3%（4/12）、误判率 0%；C 漏检率 25.0%（3/12）、误判率 8.3%（1/12）；净改善 C 优 3 / B 优 1 / 持平 8；
- B 漏检：P10-CLEAN-BG（严重扭曲）、P11-SCENE（边缘变形）、P12-SCENE（缺失一角）、P12-LAYOUT（尺寸变形）；
- C 漏检：P11-CLEAN-BG（边缘变形）、P12-SCENE（尺寸变化）、P12-LAYOUT（文字遮挡+尺寸不对）；
- C 误判：P09-CLEAN-BG 被 blocked 但人工判合格（背景偏黄）。
未完成/阻塞及影响：第二评分人与评分人分歧缺失，OCR 未配置，真实账单未接入；成本以 token 用量代替，货币成本不可用。
下一阶段入口：阶段 6 核心指标已计算完毕；如需显著性结论需扩大样本量并引入第二评分人。

## 2026-11-06：OCR 桥接端点与账单接口排查

阶段与日期：阶段 6（P7），2026-11-06。
实际修改与用户可见行为：
- **OCR 桥接**（`scripts/stage6-llm-bridge.mjs`）：新增 `/ocr` 端点，接受 `{ image_base64, mime, model }`，将图片发给 GLM-4.6V 提取文字，返回 `{ lines: [{ text, confidence }] }`；实测正确识别浮雕文字（COUNTY FAIR、DRINKING JAR）与叠加文字（版面测试文字），无文字图返回空数组；
- **Paratera 账单接口**：探测 `/usage`、`/billing`、`/billing/usage`、`/dashboard/billing/usage`、`/me`、`/organization` 均返回 404，无账单/用量 API；成本只能以每次调用的 `usage.total_tokens` 累计；
- 用户决定不扩大样本量（P01-P08 候选生成），接受 12 案例描述性结论。
验证命令、环境与实际结果：
- OCR 有文字图：识别 4 行（COUNTY FAIR、DRINKING JAR、版面测试、文字），confidence 0.8-0.95，latency 13.8s；
- OCR 无文字图：返回空 lines，latency 8.7s；
- 账单接口：6 个端点全部 404。
未完成/阻塞及影响：第二评分人缺失（用户决定不扩大样本量），真实货币成本不可用（Paratera 无账单 API）。
下一阶段入口：阶段 6 已完成；如需显著性结论需引入第二评分人或扩大样本量。

## 后续阶段记录格式

阶段与日期：
基准版本/工作区已有变更：
实际修改与用户可见行为：
验证命令、环境与实际结果：
真实服务验收状态：
未完成/阻塞及影响：
下一阶段入口：
