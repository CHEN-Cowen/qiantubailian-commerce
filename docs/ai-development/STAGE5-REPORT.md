# 阶段 5 交付报告：变更深化与套图验收

日期：2026-11-06
阶段：P5—P6（变更与套图），对应 `docs/ai-development/STAGE-PROMPTS.md` 阶段 5。
基准：分支 `feat/commerce-commercialization`；工作区原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动（本阶段未改前端）。
真实服务验收：**无**。未使用真实商品素材、真实视觉评审或真实生图服务；本阶段验收基于既有 E03 变更链路、模拟 Provider 与纯函数规则矩阵。

## 1. 变更深化

### 1.1 执行中再次变更的闸口

新增确定性保护：同一项目存在未完成变更单（`confirmed` / `executing` / `partial_failed` / `awaiting_material` / `awaiting_review`）时：

- `POST /api/projects/:id/changes/preview` 返回 `blocking_change` 与 `can_confirm: false`，商家在确认前就能看到阻塞单；
- `POST /api/projects/:id/changes` 直接返回 `409 CHANGE_IN_PROGRESS`，并带出阻塞单 `change_id`、`status` 与 `pending_items`。

原因：旧单的影响清单基于旧版本、图片尚未更新；如果允许叠加第二份变更，同一批图会被两份清单重复处理，容易产生重复扣费或静默覆盖。只有旧单 `completed` 或 `cancelled` 后才允许新建。

未改变的行为：既有文字/包装/容量/套装/SKU 变更分类、`needs_new_photo` 硬闸口、`needs_review` 覆盖依据、取消、重试、并发认领与中断恢复仍由 E03 原逻辑负责，本阶段回归全部通过。`需要确认/未知` 项仍进入人工复核；缺依赖历史图的处理仍为 `unknown`，不会冒充完成。

### 1.2 更新只处理受影响图片

沿用 E03 影响清单：`computeImpactList` 只把确实引用被改变事实/素材/商品档案的活动版本纳入更新范围，未受影响的图不重新生成。本阶段未放宽该边界。

## 2. 套图 manifest 与规则检查

新增 `src/suite.mjs`（纯函数）与 `GET /api/runs/:id/suite`（只读）。

### 2.1 单图门槛先行

每张图的当前选用版本必须：

- 存在活动版本；
- 有质量报告；
- 报告有效性为 `current`；
- 报告决策为 `publishable`。

否则套图直接 `blocked`，并在 `missing` 中列出具体交付物与原因（`NO_ACTIVE_VERSION`、`REPORT_MISSING`、`REPORT_STALE`、`BLOCKED`）。

### 2.2 跨图确定性规则

| 检查 | 状态 | 说明 |
|---|---|---|
| `SUITE_DUPLICATE_IMAGE` | fail（硬闸口） | 多个交付物输出哈希完全相同，视为重复图 |
| `SUITE_FACT_CONFLICT` | fail（硬闸口） | 同一 `fact_key` 在不同图上的展示文字不一致 |
| `SUITE_BRAND_VERSION_CONFLICT` | fail（硬闸口） | 同一套图混用不同品牌套件版本 |
| `SUITE_IMAGE_MISSING` | fail（硬闸口） | 套图缺图或缺选用版本 |
| `SUITE_REPORT_MISSING` / `SUITE_REPORT_STALE` | fail（硬闸口） | 缺报告或报告失效 |
| `SUITE_IMAGE_BLOCKED` | fail（硬闸口） | 单图仍有阻断项 |
| `SUITE_IMAGE_NEEDS_REVIEW` | unknown | 单图待复核/未知 |
| `SUITE_BRAND_COVERAGE_UNKNOWN` | unknown | 部分图缺品牌依赖记录，无法断定品牌一致 |
| `SUITE_CRITICAL_FACT_MISSING` | unknown | 关键事实未出现在任何图的依赖记录中 |
| `SUITE_APPEARANCE_UNVERIFIED` | unknown | 跨图外观/主体一致性无法由确定性规则证明 |

决策：有 fail → `blocked`；无 fail 但有 unknown → `needs_review`；全部通过 → `publishable`。未知项不会被当成通过。

### 2.3 manifest 内容

`qtb-suite-manifest.1` 包含：`suite_id`、任务/项目/规格/事实引用、品牌套件、每图版本/报告/有效性与依赖证据、逐项检查、缺失清单与决策说明。

## 3. 是否新增套图评审 Skill

**暂不新增。** 理由：

1. 真实视觉评审尚未验收，单图评审仍为模拟/待验收；此时新增套图评审只会扩大未验证面；
2. 跨图外观一致性当前如实标为 `unknown`，已有人工复核入口；
3. 待真实样本与单图评审验收后，再评估是否需要专门的套图评审 Skill，避免用新 Skill 掩盖基础能力未验收。

## 4. 测试与结果

新增 `test/ai06.js`（8 项）：7 项纯函数规则矩阵 + 1 项 HTTP 集成（含跨租户隔离与执行中再次变更闸口）。

| 命令 | 结果 |
|---|---|
| `node scripts/check.mjs` | 103 个文件语法通过 |
| `node --test test/ai06.js` | 8 通过 / 0 失败 |
| 回归 `node --test test/ai06.js test/e03.js` | 19 通过 / 0 失败 |
| 全量 `npm test` | 371 项，370 通过 / 0 失败 / 1 跳过，约 209 秒 |

全量日志：`runtime/stage5-npm-test.log`。唯一跳过项与本次改动无关。

## 5. 仍未验收与边界

- **无真实套图样本**：未用真实商品的多图素材验证跨图外观、品牌与事实一致性；
- **外观一致性为 unknown**：没有已验收的视觉评审，`SUITE_APPEARANCE_UNVERIFIED` 不会被自动消解；
- **变更类型覆盖以既有 E03 为准**：文字/包装/容量/套装/SKU 的分类与执行已有测试，但本阶段没有新增真实商品变更样本；
- **执行中再次变更采取保守拒绝**：不是合并两份变更，而是要求先完成或取消旧单；这是完整性优先的选择；
- **前端未新增套图页面**：套图清单目前只有 API，未做真实浏览器验收。

## 6. 下一阶段入口（P7 效果对照与交付）

按 `STAGE-PROMPTS.md` 阶段 6：使用人工确认的保留样本盲评，对照"通用模型直接生成 / 现有流程 / 新评审修订流程"，统计错误、漏检误判、净改善、直接采用、合格成品成本与耗时，并交付成功与失败案例、真实轨迹与结果报告。前提是先补齐真实评审、真实生图与人工标注样本；否则只能继续交付流程与评测脚手架，不能声称效果验收。
