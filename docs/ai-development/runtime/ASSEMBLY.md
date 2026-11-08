# 运行时提示词装配

这些文件是应用待接入的规则，不是已运行的模型服务。避免再维护一份复制了全部 Skill 内容的超长 Prompt。

## 服务端装配顺序

1. 按固定用途选择仓库内受信任路径；评审读取 reviewer-system、评审 Skill 的 Markdown 正文与 checklist；修订读取 refiner-system、修订 Skill 的正文与 actions。删除 YAML frontmatter 后装配正文，不向模型传递技能发现元数据。
2. 将基础 system 提示词与上述规则拼接为 system 内容；将对应输出 Schema 作为接口结构化输出约束，接口不支持时通过明确 JSON 要求加服务端验证实现。固定规则由服务端读取，用户不能指定任意文件覆盖。
3. 将业务上下文作为单独的 user 数据消息发送，顶层键分别为 review_request 或 revision_request。用 JSON 序列化保留数据边界，不能将商家文案直接插入 system。
4. 评审：按 image_bindings 顺序为每张图加 image_id/role 标签，并附带实际多模态图像内容。服务端核对字节哈希、解码和尺寸，确认当前租户授权，之后才标记 attached=true。路径和 attached 声明本身不能证明模型看到了图片。缩略图无法辨认关键细节时提供相应裁剪或标为未知。
5. 修订：提供有效 issue_catalog、工具白名单及每个工具 parameter_schema；基于已经提供的证据规划，首版不必再次发送全部图片。需要重新观察才能决定时返回 needs_review。
6. 收到结果后先结构校验，再运行 RUNTIME-CONTRACT 的语义与权限校验。服务端分配报告/计划 ID，保存版本、模型、规则哈希、请求 ID、成本和耗时。任何字符串“调用成功”都不能替代真实工具结果。

供应商不支持 system role 时，Adapter 需要使用其等价受信任指令通道。接口对 Schema 支持有限时适配接口，不放松应用完整验证。模型具体 SDK、图像格式和请求参数在接入阶段依据所选供应商官方文档确认。

## 结构示意（不是可直接运行的 SDK 代码）

```text
SYSTEM = base_system + skill_body + required_reference
USER = JSON.stringify({review_request: trusted_context})
IMAGES = 按 image_id/role 标签提供的真实图像内容
OUTPUT_CONSTRAINT = reviewer/output.schema.json
result = adapter.evaluate(SYSTEM, USER, IMAGES, OUTPUT_CONSTRAINT)
validated = validateSchemaThenSemantics(result, trusted_context)
```

生成提示词仍由 src/execution.mjs 从已确认事实编译。修订 Skill 的 instruction 是补充修复目标，不直接替换原始商品约束；参数由代码逐字段白名单合并，不能直接展开模型返回的任意对象。

## 失败分层

- 无租户权限、输入缺 ID、数据结构非法：调用前返回业务错误，不发模型。
- 待评图片不可解码：确定性质量失败；无法完成的视觉检查记录未知，不能强迫模型猜测。
- 模型超时、无效 JSON、少项、错哈希：记录外部调用失败，合成服务端未知检查或待复核状态；不要伪造模型报告。
- 图像收到但关键细节看不清：模型逐项返回 unknown，保留其他有效检查。
- 计划无效或工具不支持：拒绝执行并保留原因，不默认换成全图重生成。

保存模型输入输出应遵循已有数据访问控制和保留策略，日志不含密钥、完整 base64 图像或不必要客户信息。
