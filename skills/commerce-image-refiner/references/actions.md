# 动作选择 v1

本表定义协议词汇，不意味着当前产品已经具备全部能力。实际选择取决于服务端 available_actions 与问题级 allowed_actions。

| action | 适用 | 必要条件 |
|---|---|---|
| convert_format | 文件可解码但格式不符 | 输入有效、目标格式已定义 |
| resize_canvas | 尺寸、画布不符 | 允许的缩放/补画布，禁止拉伸主体和虚构清晰度 |
| recompose_text | 营销文字、位置、Logo | 已确认事实、既有文字层；不修改真实包装文字 |
| recompose_subject | 商品被改色/改形，恢复原主体 | 有效原始主体和合成能力；透明反光困难素材可需人工 |
| regenerate_background | 背景、光影、留白 | 具有保护主体的执行路径，原参考保留 |
| regenerate_image | 无法本地修复的成品/文件问题 | 有效原始参考和受保护生成路径；执行后全量复检 |
| masked_edit | 严格局部问题 | 真实掩码编辑能力与有效 mask，不从普通图生图推断 |

只使用一个动作；parameters 以服务端 parameter_schema 为准。不得在参数内插入路径、URL、脚本或任意 API 配置。主体/掩码等资源用服务端授权 asset_id 引用。

输出 decision：

- propose_action：存在失败证据与合法工具，提交单步计划。
- needs_material：需要标签近照、新包装实拍、有效主体或明确的包含物资料，列出具体缺项。
- needs_review：报告过期、检查冲突、SKU 不确定、事实矛盾或没有安全处理路径。
- stop：轮数、预算、时间到限，或无改善且没有有效替代策略。
- no_change：无待处理失败或必要未知；不替代正式发布检查。

如果工具支持自动执行但业务要求人工确认，仍可 propose_action；服务端依据自身确认策略暂停，模型不能绕过确认。
