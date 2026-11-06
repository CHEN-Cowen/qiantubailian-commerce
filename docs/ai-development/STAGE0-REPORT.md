# 阶段 0 核查报告：现状、测试基线与评测准备

日期：2026-11-05
范围：仅核查、基线记录与离线评测准备；未修改应用运行逻辑，未调用真实模型。
结论：当前仓库是完整可运行的 M01—M14 商品内容工具，但商品图评审/修订 Skills 尚未接入运行时；本轮交付可复跑的离线评测入口与 36 条计划案例标注表。

## 1. 已读取的依据

- 根目录无 `AGENTS.md`；开发指令集中在 `docs/ai-development/DEVELOPER-PROMPT.md` 与 `README.md`。
- `README.md`、`package.json`、`docs/PRD-商品视觉AI工作流升级开发方案.md`。
- `docs/ai-development/README.md`、`STAGE-PROMPTS.md`、`RUNTIME-CONTRACT.md`、`ACCEPTANCE-CASES.md`、`runtime/ASSEMBLY.md`、`runtime/reviewer-system.md`、`runtime/refiner-system.md`。
- 源码：`src/m07.mjs`、`src/m08.mjs`、`src/jobs.mjs`、`src/execution.mjs`、`src/store.mjs`、`src/config.mjs`、`src/ocr.mjs`、`src/api.mjs`、`src/server.mjs`、`src/providers/`。
- Skills：`skills/commerce-image-reviewer/`、`skills/commerce-image-refiner/` 及其 Schema、样例、动作表。

## 2. 四类现状（以代码为准）

### 2.1 已有且可复用

| 能力 | 实际实现 | 可复用点 |
| --- | --- | --- |
| 机器质检与决策 | `src/m07.mjs` 固定检查注册表、`decideQuality`、`computeReportValidity`、`applyHumanReview` | 报告结构、决策门槛、人工复核、报告有效性绑定 |
| OCR 适配 | `src/ocr.mjs` 从 `QTB_OCR_ENDPOINT` 读取，未配置时返回 `OCR_NOT_CONFIGURED` | 文字类证据的“未知不猜”路径 |
| 自动修订预算 | `src/m08.mjs` 的 `REVISION_MAX_ROUNDS`、`REVISION_MAX_NO_IMPROVEMENT`；`src/jobs.mjs:1579` 的轮次/额度/无改善停止 | 受控循环的停止条件与预算保护 |
| 版本与导出 | `src/m08.mjs` 的 `makeVersionRecord`、`compareRevisionOutcome`、`planExport`、`buildManifest` | 修订前后版本、退步检查、导出闸口 |
| 任务与事件流 | `src/jobs.mjs` 的 run/attempt/event、确认与取消、租户隔离 | 后续把评审/修订作为受控步骤接入的骨架 |
| 授权评测集与候选模型 | `src/m09.mjs`、`store` 的 `eval_dataset_items`/`eval_reports`/`model_candidates` | 评测集、冠军-挑战者与灰度逻辑；但门槛语义与视觉评审不同（见 2.4） |
| 图像处理 | `sharp`、`src/raster.mjs`、`src/m06.mjs` | 素材解码、上传图约束、合成与栅格排版 |
| 协议材料 | 两个 Commerce Skills 及 `validate-materials.ps1` | Schema、合成正例、关键拒绝分支 |

### 2.2 需要扩展或新增

| 缺口 | 现状证据 | 后续阶段 |
| --- | --- | --- |
| 多模态评审 Adapter | `src/` 中无 `vision`/`multimodal`/`SKILL.md` 加载代码；`m07` 的 `VISUAL_QUALITY` 恒为 `unknown`（`src/m07.mjs:684`） | P2 |
| 评审报告持久化与映射 | `store` 集合无 `visual_reviews`；只有 `quality_reports`（`src/store.mjs:14-23`） | P2 |
| 修订动作规划 | `FIXABLE_CHECKS` 仅 4 个格式/完整性/风险码，动作固定 `regenerate`（`src/m08.mjs:21-26, 38-64`） | P3 |
| 受控循环步骤持久化 | 无 `revision_plans`/`loop_steps`/工具调用幂等表；现有修订历史仅存在 `run.revision.history`（`src/jobs.mjs:1013`） | P3 |
| 视觉评审 API | 只有 `quality-reports` 读取/复核端点（`src/api.mjs:348,384,932`），无评审导入/修订计划端点 | P2/P3 |
| 前端证据与修订 UI | `frontend/` 无“评审证据/修订计划/循环步骤”面板 | P5 |
| AI 配置与成本 | `src/config.mjs` 只有额度/节拍/租户；无视觉模型、超时、单次成本、总预算配置 | P2/P3 |
| 更新任务与整套一致性 | 无变更前后事实绑定、受影响版本计算、套图清单 | P4 |
| 效果指标闭环 | 无人工标签、漏检率/误拦截/净改善的计算入口 | P7 |

### 2.3 仅通过模拟验证的功能

- 默认 Provider 为 `mock`（`.env.example:17`），生成图为模拟图，不证明真实模型效果。
- Seedream Adapter 存在，但 `supports_mask=false`，没有掩码编辑（`src/providers/seedream.mjs:73`）；未完成真实模型验收。
- OCR 默认未配置；文字类结论保持未知（`src/ocr.mjs:36-44`）。
- 所有现有 E2E/截图/HTTP 验收均基于模拟外部服务。

### 2.4 已完成真实外部服务验收的功能

- 无。仓库明确标注“真实模型效果、OCR 准确率、商户收款和退款仍需授权外部验收”（`README.md:5`）；支付默认关闭（`.env.example:26-27`）。
- M09 的评测集/冠军挑战者是本仓库内的规则与数据校验，不代表真实模型评测已完成。

## 3. 文档偏差纠正（依据为实际代码）

| 文档说法 | 实际代码 | 处理 |
| --- | --- | --- |
| `README.md:118` 写“300 项全量回归” | 本轮基线为 308 项（新增 `test/ai01.js` 后为 314 项） | 以实际计数为准；不改 README 历史描述，记录在案 |
| PRD 第 36 行说 Skills 含“整体编排” | `skills/` 仅有 reviewer、refiner、image-quality-refiner、novel-scene-image、novel-scene-to-prompt、scene-image-critic；`docs/ai-development/README.md:33` 明确“不创建未经验证的额外编排 Skill” | PRD 此句为过时描述，不据此新增编排 Skill |
| PRD 第 32 行说 m07 已做“机器检查、OCR、未知与人工复核” | 属实；但视觉质量仍是 `unknown`，OCR 默认未配置 | 保留，标注能力边界 |
| PRD 第 33 行说 m08 做“有限自动修订” | 属实；但只有 4 个可修码、动作只有 `regenerate` | 保留，标注与 P3 目标差距 |
| `docs/ai-development/README.md:3` 称“应用尚未加载新 Skills” | 经源码检索属实，无 Skill 加载器 | 作为 P2 前置事实 |
| `RUNTIME-CONTRACT` 要求服务端完整语义校验 | 目前仅 PowerShell 交接脚本，无应用侧校验 | 本轮新增 `src/visual-contract.mjs` 作为可复用纯函数校验，未接入运行时 |
| M09 评测集门槛 100 SKU / 20 保留 | `src/m09.mjs:17-18` 明确为模型冠军挑战赛门槛 | 视觉评审 P0 的 40—60 案例是另一类评测，不能直接复用该门槛 |

## 4. 测试基线

环境：

- 项目要求 Node `>=22.22.2 <23`（`package.json:7`）。
- 当前 shell 默认 Node 为 v24.20.0，不满足 engines；基线统一使用 `runtime-tools/node-v22.22.2-win-x64/node.exe`。
- 工作区已有未提交修改：`frontend/app.js`、`frontend/index.html`；本轮未改动。

命令：

```powershell
$env:Path="e:\游戏\千图百炼\runtime-tools\node-v22.22.2-win-x64;"+$env:Path
node --test --test-concurrency=4 test/index.js test/ui-contract.js test/m03.js ... test/home.js
```

结果（`npm test` 文件清单当时的版本，未含新增 `test/ai01.js`）：

- 308 项，302 通过，5 失败，1 跳过，耗时约 622 秒。
- 失败项：
  1. `E03 集成：重生成执行闸口——报价确认缺失 409 / 报价过期 409 / 余额不足 402`
  2. `优雅关闭空闲与正在处理的连接，close 可重复调用`
  3. `导入服务模块不自动启动，loadEnvFile 保留外部环境值`
  4. `真实启动失败脱敏：非法环境与端口冲突`
  5. `真实子进程启动、IPC 就绪、HTTP 健康检查与 SIGTERM 正常退出`

失败归类与复核：

- 上述 5 项均为启动/关闭/超时类重资源用例。按文件单独复跑：
  - `test/index.js`：11 项，10 通过、1 跳过、0 失败；
  - `test/e03.js`：11 项全部通过。
- 判定：并发 4 个测试文件在 Windows 上造成端口/子进程/内存竞争，属于既有基线的环境抖动，不是本轮代码回归；全量回归时仍会间歇出现，需在 P2 前决定是否将启动类用例改为串行或延长超时。

本轮新增测试：

- `test/ai01.js`：6 项全通过（协议正例、拒绝分支、标注表完整性、CSV 读写）。

## 5. 评测准备交付

### 5.1 样本标注表

- 文件：`docs/ai-development/eval/p0-cases.csv`。
- 规模：12 个授权素材 × 3 个任务场景 = 36 条计划案例。
- 划分：按商品划分，P01—P08 为开发集，P09—P12 为保留集；同一商品不跨集。
- 诚实边界：所有行 `candidate_version=pending_generation`、`fact_status=unconfirmed`、`label_status=pending_human`、`review_result=pending_human_confirmation`。没有任何真实质量标签，不能用于计算漏检率/误拦截/净改善。
- 与目标差距：PRD 要求约 40—60 个有人工标签的案例；当前只有 12 个授权图片且没有生成候选图，不虚构标签，待补足授权商品与候选图后再扩表。

### 5.2 可复跑评测入口

- 文件：`scripts/ai-eval.mjs`，命令 `npm run ai:eval`。
- 覆盖：
  1. 样本表表头/行数/商品划分/标签状态/“事实未确认”约束；
  2. 12 份素材的原始图 SHA-256、上传图可解码、最长边 ≤2048、JPEG、作者与许可证；
  3. 两个 Skills 的 10 个合成协议样例；
  4. 20 个拒绝分支（重复检查项、绑定不一致、坐标反向、缺图却判定、fail 无修复建议、未知无原因、候选图自引用、无参考图却 pass、过期报告执行、动作越权、目标非 fail、越预算、未授权素材、未解决必需项、补素材缺失、分支夹带动作等）。
- 当前输出：样本 36 行 / 12 商品 / 开发集 8 / 保留集 4；标签 0 待确认 36；素材 12 全部哈希、解码、尺寸、授权通过；协议评审 4/4、修订 6/6、拒绝 20/20；效果指标明确不可计算。

### 5.3 应用侧协议校验

- 新增 `src/visual-contract.mjs`：纯函数 `validateReviewOutput` 与 `validateRevisionPlan`。
- 作用：把 `RUNTIME-CONTRACT` 的结构与语义规则变成可测试代码，为 P2/P3 的 Adapter 与 Loop 提供复用校验；本轮未接入运行时。
- 边界：Schema 的 `additionalProperties` 以外规则由手写校验覆盖；`parameter_schema` 只实现当前动作所需的最小 JSON Schema 子集（type/enum/const/required/items/anyOf/min/max 等）。

## 6. 已有失败记录与风险

1. 全量回归并发跑会出现 5 个重资源用例间歇失败；单独跑通过。未修复，留待决定测试并发策略。
2. 默认 Node 24 与 engines 冲突；开发/验证必须显式使用 Node 22.22.2。
3. 真实模型、OCR、支付均未验收；“真实效果指标”不可用。
4. 只有 12 个授权测试素材且无真实候选图，P0 的 40—60 个标注案例尚未达到。
5. Skills 未被应用加载，评审/修订协议目前只有离线校验，不等于产品已具备 AI 评审能力。

## 7. 下一阶段入口

P1（商品事实与评测基线）开始前需要确认：

- 是否接受以 12 个 Wikimedia 授权素材作为开发/保留集起点，并补足到 40—60 个案例；
- 是否同意在全量回归中把启动/关闭类用例串行执行，以消除间歇失败；
- 是否为 P2 提供真实多模态模型端点与密钥（不写入仓库），否则只能继续用合成协议与 mock 验证。

P2 需要的最小接口（本轮未实现，仅记录）：

- 素材读取：附带的候选图与参考图必须实际解码并传入 Adapter，不能只传路径；
- 评审输出：固定 8 项、状态枚举、证据、可选区域、参考图归属、未知原因；
- 服务端：上下文哈希/版本哈希绑定、报告持久化、失败与超时降级为“不可用/人工复核”；
- 成本与超时：单次预算、总预算、截止时间，超限不得执行。
