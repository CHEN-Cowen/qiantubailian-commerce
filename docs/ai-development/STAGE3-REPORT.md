# 阶段 3 交付报告：商品图修订接入

日期：2026-11-05
阶段：P3（商品图修订），对应 `docs/ai-development/STAGE-PROMPTS.md` 阶段 3。
基准：分支 `feat/commerce-commercialization`；工作区原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段修改 `frontend/workbench.js`、`frontend/api.js`）。
真实服务验收：**无**。未配置真实修订规划模型端点，没有真实模型建议、真实改图效果或人工对照；本阶段验收全部基于注入模拟器与本地确定性逻辑。

## 1. 本阶段做了什么

新增 `src/revision-planner.mjs`，把 `commerce-image-refiner` Skill 从文档变成"只给建议、不自动执行"的规划组件。

| 能力 | 实现 | 说明 |
|---|---|---|
| 规则装配 | `loadRefinerRules()` | 读取 `runtime/refiner-system.md`、`skills/commerce-image-refiner/SKILL.md`、`references/actions.md` 与 `output.schema.json`，生成 `rules_hash` |
| 统一问题清单 | `buildIssueCatalog()` | 只收录 `fail` 与"必需但未知"的检查；每项带优先级、证据、`allowed_actions`、`needs_material` |
| 真实能力推导 | `resolveAvailableActions()` | 动作只来自真实能力：本地格式/画布、有文字层才给 `recompose_text`、有主体保护才给 `recompose_subject`、`supports_mask` 才给 `masked_edit`、有生成能力才给重新生成 |
| 请求绑定 | `buildRevisionRequest()` | 冻结 `context_hash`、`report_hash`、`source_version_id`、`artifact_hash`、保留通过项清单与轮次限制；缺原始版本时 `artifact_hash` 为 `null`，不编造 |
| 最小 Adapter | `createRevisionPlanner()` / `createRevisionPlannerFromEnv()` | `POST` 到 `QTB_REVISION_PLANNER_ENDPOINT`；超时、HTTP 错误、非 JSON、网络异常均归类为明确状态，不抛出 |
| 策略校验 | `validateRevisionPlan()` | 校验绑定字段、动作权限、目标必须属于问题清单、参数洁净（拦截 URL/路径/脚本/API 配置）、锁定约束、轮次；`needs_material` / `needs_review` / `stop` 都要有理由 |
| 确定性兜底 | `deterministicPlan()` | 无模型或模型失败时，用第一个有合法动作的问题生成最小建议；轮次用尽直接 `stop`；没有工具路径转补素材 |
| 用户可读计划 | `presentRevisionPlan()` | 输出动作、目标检查项、执行说明、必须保留项、补素材清单、失败原因；固定 `executable:false`、`executed:false` |

接入点：

- `src/jobs.mjs`：新增只读方法 `revisionPlanningInput()`，复用质量报告的生效性判断，冻结报告、事实、规格、品牌、交付物与生效版本；不写库、不调用模型。
- `src/api.mjs` / `src/server.mjs`：支持构造注入 `revisionPlanner` 与环境变量；`GET /api/provider/capabilities` 返回 `revision_planner`（`configured/mode/acceptance/auto_loop:false/requires_confirmation:true/executable_actions`）。
- 新增接口：
  - `POST /api/runs/:id/revision-plans`：生成建议，不扣费、不改图；报告失效直接 `409 REPORT_STALE`；同一报告/上下文/版本复用同一条待确认记录。
  - `GET /api/runs/:id/revision-plans`：列出建议与执行状态。
  - `POST /api/runs/:id/revision-plans/:planId/execute`：人工确认执行。要求 `confirm:true` 与 `Idempotency-Key`；执行前重新核对报告有效性、目标问题仍存在、商品上下文未变化；复用既有 `launchRegeneration` 创建单步子任务并重新评审。
- `src/store.mjs`：新增 `revision_plans` 表（旧数据自动迁移为空表）。
- 前端：`frontend/workbench.js` 在 QA 区块展示"修订建议"（状态、动作、步骤、是否可执行）与"生成修订建议/确认执行"按钮；`frontend/api.js` 增加三个调用方法。规划免费，执行必须二次确认。

## 2. 环境变量与降级语义

| 变量 | 作用 |
|---|---|
| `QTB_REVISION_PLANNER_ENDPOINT` | 未设置即"未配置"，只输出确定性建议 |
| `QTB_REVISION_PLANNER_API_KEY` | 可选的 Bearer Token |
| `QTB_REVISION_PLANNER_MODEL` | 请求中的模型标识 |
| `QTB_REVISION_PLANNER_TIMEOUT_MS` | 调用超时，默认 20s |

降级状态：`not_configured`、`unavailable`、`timeout`、`error`、`http_error`、`invalid_json`、`invalid_output`。模型输出未通过校验时整体降级为确定性建议并展示拒绝原因；**超时/非法输出不会给出执行入口**。

## 3. 人工触发的执行边界

可执行动作只有 `regenerate_image`、`regenerate_background`、`recompose_subject`，它们复用既有重生成流程（新建子任务、冻结快照、重新 QA）。

以下动作没有执行入口，接口明确返回 `409 ACTION_NOT_EXECUTABLE`：

- `convert_format`、`resize_canvas`：本阶段没有安全的本地转换入口。
- `recompose_text`：已有独立文字层编辑接口，但规划输出是自然语言说明，不能直接转成结构化文字编辑参数。

这样做是为了避免"用户点了确认，系统实际做了另一件事"。执行仍为单步，不会因执行再次自动规划。

## 4. 验收场景与证据

| 场景 | 测试 | 结论 |
|---|---|---|
| 规则装配 | `P3 规则装配` | 规则哈希稳定，含 Skill 与动作规则 |
| 真实能力 | `P3 能力推导` | 未具备的能力不出现在 `available_actions` |
| 问题清单 | `P3 问题汇总` | 通过项排除；必需未知纳入；无合法动作的问题要求补素材 |
| 请求绑定 | `P3 请求绑定` / `P3 缺原始参考图` | 哈希与版本冻结；缺版本时 `artifact_hash=null` |
| 不支持动作 | `P3 不支持动作` | `ACTION_NOT_AVAILABLE` / `TARGET_ACTION_MISMATCH` |
| 通过项退步 | `P3 通过项退步` | 目标不能是已通过项；复检退步 `improved=false` |
| 错误绑定 | `P3 错误绑定` | `context_hash` / 版本 / 报告任一不符都拒绝 |
| 参数注入 | `P3 参数注入` | URL、密钥、路径、脚本全部拦截 |
| 轮次限制 | `P3 轮次限制` | 轮次用尽只能 `stop` |
| 补实拍 | `P3 补实拍` | 无工具路径时 `needs_material`，空清单被拒 |
| 人工复核 | `P3 人工复核` | 仍有合法动作时不能直接转复核 |
| 未配置降级 | `P3 未配置规划模型` | `deterministic`，仍要求人工确认 |
| 非法输出 | `P3 规划输出非法` | `invalid_output` + 拒绝原因，不执行 |
| 端点失败 | `P3 规划端点失败` / `P3 模型返回非法 JSON` | 归类超时/HTTP/非法 JSON，不抛出 |
| 不执行 | `P3 建议不执行` | 计划不含执行/计费结果 |
| HTTP 规划 | `P3 HTTP：未配置规划器` | 能力如实标注；规划 201 且不执行；跨租户 404 |
| HTTP 执行 | `P3 HTTP：动作未通过校验...幂等` | 未确认 428、缺幂等键 400、确认后创建子任务、重复请求返回同一子任务 |
| 旧报告失效 | `P3 HTTP：旧报告或已解决目标` | 事实版本变化后规划返回 `409 REPORT_STALE`，不留下可执行建议 |

## 5. 验证结果

环境：Node `v22.22.2`。

| 命令 | 结果 |
|---|---|
| `node scripts/check.mjs` | 100 个文件语法通过 |
| `node test/ai04.js` | 20 通过 / 0 失败 |
| 回归 `node test/m05.js` `m07.js` `m08.js` `m13.js` `r04.js` `e03.js` | 64 通过 / 0 失败 |
| 全量 `npm test` | 354 项，353 通过 / 0 失败 / 1 跳过，约 226 秒 |

全量测试日志：`runtime/stage3-npm-test.log`。日志内无失败项；唯一跳过项与本次改动无关。

## 6. 仍未验收与边界

- **真实规划模型未验收**：没有真实端点与样本，无法评估建议的合理性、动作选择准确率；未配置时只有确定性建议。
- **真实改图效果未验收**：执行入口只复用既有重生成流程，生成质量仍取决于 Provider；重新评审后需人工比较"通过项是否退步"，本阶段没有自动对照看板。
- **部分动作不可执行**：格式转换、画布缩放、文字重排只有建议，没有一键执行；文字层执行仍走既有文字编辑接口，需人工填参数。
- **无自动循环**：本阶段没有"失败自动重试直至通过"的循环，也没有自动扣费；每次执行都由用户确认。
- **真实视觉评审仍为 unknown**：阶段 2 未配置端点，因此修订建议主要来自确定性 QA 与规则，不是真实看图结论。
- **HTML 页面未做浏览器验收**：前端改动只经过语法检查与既有 UI 契约测试，没有进行真实浏览器交互验收。

## 7. 下一阶段入口（P4 受控修订循环）

按 `STAGE-PROMPTS.md` 阶段 4：在已有单步建议与人工执行之上，增加受控自动修订（最多 3 轮、无改善 2 次终止、预算预留、取消迟到、未知不重提），并以真实服务验收为前置条件。
