# P0 样本标注表使用说明

文件：`p0-cases.csv`（由 `npm run ai:eval -- --export-labels docs/ai-development/eval/p0-cases.csv` 生成）。

## 当前状态

- 12 个授权测试素材（Wikimedia Commons，CC BY / CC BY-SA / CC0，作者与许可证见素材目录的 `素材清单.json`）。
- 每个商品 3 个计划场景：`clean_bg`（干净背景主图）、`scene`（生活场景图）、`layout`（基础文案排版图），共 36 条。
- 按商品划分：P01—P08 开发集，P09—P12 保留集；不按同商品近似图随机拆分。
- 全部为“计划案例”：没有真实生成候选图，也没有人工确认标签。

## 填写规则

1. 先补 `candidate_version` 与候选图版本 ID；没有候选图时保持 `pending_generation`。
2. `fact_status` 只有在商家提供并核验过品牌、材质、尺寸、容量、卖点后才可改为 `confirmed`；不要根据图片猜测。
3. `label_status` 只能在标注人完成并复核后改为 `confirmed`，同时填写：
   - `expected_issues`：问题码与可见证据；
   - `visible_evidence`：能指向画面位置的具体描述；
   - `expected_status`：`pass` / `fail` / `unknown` / `not_applicable` 或业务状态；
   - `annotator`、`review_result`。
4. 未确认的行必须保持 `expected_status=pending_human_confirmation`、`review_result=pending_human_confirmation`；`npm run ai:eval` 会拒绝提前写入的预期结论。
5. 一次只改一个商品的同类场景，改完运行 `npm run ai:eval`；结构或素材错误会直接失败。

## 口径

- 真实效果指标只在有确认标签后计算；当前报告会明确输出“没有任何人工确认标签”，不得据此宣称漏检率、误拦截或净改善。
- 本表不替代 P2 的运行时校验；它只用于离线评测与人工标注。

## 阶段 6 保留集工作簿

阶段 6 只使用保留集 P09—P12，不参与开发调参。

- 工作簿：[holdout-cases.csv](../stage6/holdout-cases.csv)（由 `npm run stage6:prepare` 从规范表生成，12 行）。
- 结构与 `p0-cases.csv` 完全一致，标注规则同上；不要在两份表里分别维护同一行，以规范表为准再重新生成。
- 每完成一个商品的三行，运行 `npm run stage6:ready`；只有 `confirmed=12` 时才能进入盲评统计。
- 标签确认必须由人完成。AI 预标只能写成“AI 预标（待人工确认）”，不能把 `label_status` 改成 `confirmed`。

### 三臂盲评约定

1. 三臂共用同一个生图模型与同一份原始素材、任务、预算，只改变工作流：A 通用模型直接生成、B 现有确定性流程、C 新评审修订流程。
2. 候选图统一去掉臂标识后随机编号，交给人工评分；臂与编号的映射单独保存，评分人看不到。
3. 评分维度：事实错误、漏检、误判、未知、净改善、是否直接采用、合格成品成本与耗时、更新遗漏。
4. 样本规模与分歧必须写进报告；样本少于 12 条时只报告描述性结果，不做显著性结论。
5. 供应商账单未接入前，成本标为“未知/供应商用量”，不能写成已核验货币成本。
