# 阶段 4 交付报告：受控 Agent Loop（自动修订控制面）

日期：2026-11-06
阶段：P4（受控修订循环），对应 `docs/ai-development/STAGE-PROMPTS.md` 阶段 4。
基准：分支 `feat/commerce-commercialization`；工作区原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段未改前端）。
真实服务验收：**无**。未配置真实视觉评审、修订规划或生图服务，没有真实模型驱动的自动修订、真实净改善率或真实人工对照；本阶段验收全部基于注入模拟器、确定性硬失败修订与本地控制面逻辑。

## 1. 本阶段做了什么

在已有单步修订与人工执行之上，补齐自动修订的**控制面**。真实评审/规划未验收，因此没有开启模型驱动的自动循环；系统只对机器可判定的硬失败执行单步修订，并把"未启用"如实暴露。

| 能力 | 实现 | 说明 |
|---|---|---|
| 任务内自动修订 | `src/jobs.mjs` `scheduleRevisions()` | 复用既有预算、幂等、并发与取消机制，只处理 `FIXABLE_CHECKS` 中的硬失败 |
| 修订模式 | `run.revision.mode` | `hard_failure_only` / `disabled`；未声明修订能力的 Provider 明确写 `disabled` |
| 权限检查 | `run.revision.permission` | 提交前校验 `automatic === true`；未授权直接 `permission_denied` 停止 |
| 能力检查 | `run.revision.capability` | 记录 Provider 修订能力、验收状态、视觉评审配置与验收状态 |
| 视觉闸口 | `run.revision.visual` | `max_rounds: 1`；只有评审 `acceptance === 'verified'` 才可能启用，未验收时 `enabled:false` 且标注原因 |
| 轮次上限 | `run.revision.max_rounds` / `round` | 受既有预算、`max_credits`、连续无改善与任务级上限共同约束 |
| 上下文变化闸口 | `reportValidityIn()` + `context_check` | 报告失效（事实/规格/品牌/规则/文件变化）时停止，不拿旧报告驱动新动作 |
| 版本选择 | `selectRevisionVersion()`（m08） | 只有净改善才自动替换选用版本；无改善或通过项退步时新版本只留历史，原版本保持选用 |
| 轮次轨迹 | `run.revision.history` | 每轮记录动作、修订前后版本/报告、费用、延时、选中版本、选择原因与前后检查结果 |
| 停止原因 | `run.revision.stop_reason` | `provider_unsupported`、`permission_denied`、`mode_unsupported`、`no_improvement`、`context_changed`、`budget_exhausted`、`max_rounds` |
| 内部成本 | `run.revision.spent_credits` / `metrics` | 复用既有额度捕获；未捕获不记为花费；供应商成本仍按生成记录汇总 |
| 指标 | `computeRevisionMetrics()`（m08）/ `GET /api/metrics` | 轮次、净改善率、成本、平均/最大延时；无轨迹时返回 `null`，不用 0 冒充 |
| 更多轮次决策 | `metrics.business.revision.more_rounds_decision` | 有数据且净改善率 ≥ 0.5 才标 `eligible_for_review`，否则 `not_eligible`；无数据 `insufficient_data` |
| 能力端点 | `GET /api/provider/capabilities` | 新增 `revision_control`（模式、自动轮次、视觉自动循环、视觉闸口、说明） |

## 2. 自动修订的边界

1. **只修机器硬失败**：`FILE_INTEGRITY`、`FILE_FORMAT`、`SIZE`、`RISK_CONTENT`；一次只推进一个关键项，已通过项写入 `preserve_checks`。
2. **视觉自动修订默认关闭**：未配置或未验收的评审能力不会触发自动循环；视觉类问题仍走阶段 3 的人工确认建议。
3. **不扩大预算**：继续使用报价冻结的 `max_credits` 与任务预算，触顶即 `budget_exhausted`，不自动加额。
4. **不改变用户收费**：自动修订只在原有预留额度内捕获；用户额度与计价规则未改。
5. **不复活任务**：取消后的迟到结果只入审计，不写产物、不捕获费用。
6. **未知不重提**：查单 `unknown` 保持原 `provider_job_id`，不换新请求、不重复扣费；超过对账窗口转人工核对。
7. **上下文变了就停**：报告失效时停止修订，不基于过期证据改图。

## 3. 验收场景与证据

新增 `test/ai05.js`（9 项）：

| 场景 | 测试 | 结论 |
|---|---|---|
| 版本选择 | `P4 版本选择` | 改善才替换；退步/无改善保留原版本 |
| 指标口径 | `P4 修订指标` | 净改善率、成本、延时来自真实轨迹；无轨迹为 `null` |
| 控制面暴露 | `P4 控制面` | 能力端点与任务详情如实标注模式、权限、能力与视觉闸口 |
| 修订无改善 | `P4 修订无改善` | 新版本不选用，原版本保持 active，停止原因可追溯 |
| 上下文变化 | `P4 上下文变化` | 事实版本更新后 `stop_reason=context_changed`，不提交修订 |
| 取消迟到 | `P4 取消迟到` | 任务保持 `cancelled`，迟到成功只入审计，无版本产生 |
| 未知请求 | `P4 未知请求` | 同一交付物只提交 1 次，窗口后转 `needs_attention` |
| 重启恢复 | `P4 重启恢复` | 按同一幂等键重挂，不新增调用、不重复结算 |
| 并发预留 | `P4 并发预留` | 额度只够一份时一单 201、一单 402，扣费不超预留、余额不为负 |

同时修复了一个真实并发缺陷：`store.putBlob` 在 Windows 上并发写入同一内容寻址文件时，目标已存在会让 `rename` 返回 `EEXIST/EPERM`；现在确认目标文件存在后按成功处理，避免并发创建任务返回 500。

## 4. 验证结果

环境：Node `v22.22.2`。

| 命令 | 结果 |
|---|---|
| `node scripts/check.mjs` | 101 个文件语法通过 |
| `node test/ai05.js` | 9 通过 / 0 失败 |
| 回归 `node test/m08.js test/ai04.js test/r02.js` | 31 通过 / 0 失败 |
| 全量 `npm test` | 363 项，362 通过 / 0 失败 / 1 跳过，约 243 秒 |

全量测试日志：`runtime/stage4-npm-test.log`。日志内无失败项；唯一跳过项与本次改动无关。

## 5. 仍未验收与边界

- **真实视觉自动修订未启用**：没有验收过的多模态评审，`visual.enabled` 保持 `false`；因此本轮没有真实"看图 → 自动改图 → 复检"闭环。
- **真实净改善率未知**：指标只汇总模拟器与确定性硬失败修订的轨迹，不能代表真实模型效果；`more_rounds_decision` 只是内部评估门槛，不等于已开放更多轮次。
- **真实供应商成本未验收**：只有内部额度与用量记录；供应商金额仍以结算单为准。
- **修订退步只覆盖检查项**：`compareRevisionOutcome` 能识别通过项退化，但无法判断"更好看"这类主观质量。
- **前端未改**：本阶段未新增页面或交互；既有 QA 与修订建议界面未做真实浏览器验收。

## 6. 下一阶段入口（P5 变更与套图）

按 `STAGE-PROMPTS.md` 阶段 5：先完成变更深化，再完成套图验收；扩展确定性依赖，保留视觉候选的不确定性，逐项验证文字、包装、容量、套装、SKU 变更及执行中再次变更，并新增套图 manifest 与跨图一致性检查。
