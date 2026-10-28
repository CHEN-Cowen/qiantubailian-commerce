# 商品内容维护扩展：完整开发接手包

用户已选择继续准备完整开发，不把公开案例探索替代实施范围。本次仅上传提示词、方案与研究参考，未执行三个扩展功能的代码开发。

## 使用方法

把 [完整开发总提示词](MASTER-PROMPT.md) 交给开发软件，要求读取本目录所有必读材料，按 [分模块/服务执行提示词](MODULE-PROMPTS.md) 的 E00—E08 连续推进。

每模块：开发 → 自测 → 修复复测 → 独立提交 → 推送并核对 → 自动下一模块。所有模块后：整体端到端 → 修复复测 → 最终提交推送。

## 文件

- [MASTER-PROMPT.md](MASTER-PROMPT.md)：完整功能、边界、费用、执行和最终验收要求。
- [MODULE-PROMPTS.md](MODULE-PROMPTS.md)：9个模块任务卡、通用执行、后端服务和断点续做提示词。
- [PRD.md](PRD.md)：原商品变更/SKU核对/疑问补图完整方案。以总提示词纳入的后续优化为当前要求。
- [BASELINE.md](BASELINE.md)：原体验优化最新提交衔接与并行工作保护。
- [RESEARCH.md](RESEARCH.md)：公开案例报告，问题来源与证据边界。
- [INTERVIEW.md](INTERVIEW.md)：后续商家访谈参考，当前无需先完成访谈再开发。
- [EVIDENCE.csv](EVIDENCE.csv)：公开研究证据索引；[INTERVIEW-NOTES.csv](INTERVIEW-NOTES.csv)：空白访谈记录，均非已发生的用户验收结果。

原先 [绿色界面与制作体验接手包](../experience-optimization/README.md) 保持独立。本包用于增量扩展，先检查已有实现，不重复覆盖原任务。

所有用户功能应前后端联通，确定规则与视觉未知分开；用户满意、质检合格、付费和外部替换分别表达。完整开发不等于承诺未授权的模型、真实交易或自动店铺同步已验收。
