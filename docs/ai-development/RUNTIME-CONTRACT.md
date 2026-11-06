# 运行时契约与校验

版本：commerce-runtime.1。输出 JSON Schema 位于各 Skill 的 references 中；此文定义无法仅靠 Schema 保证的应用校验与输入内容。

## 商品上下文

服务端从受权项目读取并冻结：tenant/project/sku ID、事实版本、有效事实列表（含 key/value/unit）、包装关键文字、包含/不包含物、素材 ID/版本/哈希/角色、品牌版本、spec、允许的变换、当前文字层版本。展示名不能充当身份依据。

context_hash 按现有稳定哈希机制计算，至少包含上述内容、检查规则版本；待评文件另以 artifact_hash 绑定。Skill 正文、引用规则与模型版本加入缓存键和调用元数据。资料变更后旧报告失效，不沿用旧通过结论。

## review_request

| 字段 | 要求 |
|---|---|
| context_hash / artifact_version_id / artifact_hash | 非空，来自当前上下文与待评版本 |
| context | 上述冻结数据的模型所需最小子集，无密钥/用户账户资料 |
| image_bindings | image_id、asset_id（成品可 null）、role、attached；恰有一个 candidate；image_id 唯一 |
| required_check_codes | 固定为评审输出 Schema 中的八个 code，不允许由商家删减 |

图片通过多模态消息发送，非 JSON 内任意本地路径。服务端验证 candidate 与 artifact_hash 相符，参考图与素材角色、SKU 对应；style 不算主体参考。素材缺失可以送评以返回局部未知，但不能静默删除检查项。

### 输出语义校验

1. ID/哈希/版本必须与本次请求严格相同；八个 code 各一次，禁止重复替代遗漏。
2. reference_image_ids 只能来自实际送入的参考图，不能引用 candidate 为自身商品一致性依据。附带资料不足时商品对照检查不能 pass。
3. region 非空时满足 0≤x1<x2≤1、0≤y1<y2≤1。无效定位拒收或记录明确解析失败，不默认为全图证据。
4. fail 和 unknown 需要非空 suggested_fix（unknown 写补证据建议），unknown_reasons 必须列出未知原因。unavailable 时全部 unknown；partial/unavailable 必须有缺失原因。
5. not_applicable 必须和 spec/事实兼容，程序不能允许关键商品检查靠此绕过。只比较字段不足以验证自然语言证据，真实样本还须人工评测。
6. 服务端根据固定检查注册表设置 required、hard_gate、adjudicable 与 label，映射到现有 m07。商品关键视觉项首版默认 required 且 hard_gate：明确 fail 阻断、unknown 待复核；构图/融合按交付要求设为必需。模型不得覆盖这些字段。
7. 规则/OCR/视觉分别保存检测来源与原始状态；矛盾时保留全部证据并按现有较严格门槛处理。人工裁决使用现有可裁决未知项规则，不能覆盖硬失败。

## revision_request

字段包含 context_hash、source_version_id、based_on_report_id、context、issue_catalog、report_valid、available_actions、history、limits。服务端为每个 issue 提供 code/status/evidence/priority/required/allowed_actions；已通过项也传入作为保留依据。priority 数值越小优先级越高，同级按确定性顺序排序。

limits 包含 remaining_rounds、budget_remaining（统一内部计量单位）、minimum_action_cost、deadline_reached。工具可估算实际成本时传入逐动作预算信息；无法估算的收费动作不能自动执行。用户收费继续沿用成品点数规则。

available_actions 的每项包括 action、allowed_asset_ids、parameter_schema、requires_confirmation 和实际限制。动作名取自 Skill 的动作表，但只注册真实实现且已验证的工具；不支持 masked_edit 时完全不提供它。

### 输出语义校验与执行

1. 核对绑定字段、report_valid 和当前资料；过期仅接受 needs_review。达到硬限制只接受 stop，或无执行请求的明确状态；不执行任何动作。
2. propose_action 的所有 target_check_codes 必须是当前 fail 项，action 同时属于其 allowed_actions 和 available_actions；未知项不允许自动修。
3. parameters 使用对应 parameter_schema 校验，再核对素材归属与 allowed_asset_ids、文字来源、目标尺寸及确认状态。参数 Schema 不允许任意额外字段。模型 instruction 作为修复目标并入原始约束，不变成系统指令。
4. 确定最终报价和预算预留后再调用工具。模型不能新增供应商请求配置、URL、本地路径或额度。动作需要人工确认时沿用确认门槛，不以 propose_action 作为授权。
5. needs_material 至少给一条具体素材请求；needs_review/stop 记录原因；no_change 仍需程序确认所有必需项已解决。返回非动作分支时不得执行工具。
6. 保存 plan → tool_call → artifact_version → review 的关联及幂等键，执行后重新评审通过项与失败项。调用超时为在途未知或失败的事实状态，不自行假设未扣费并重新提交。

## 版本与执行轨迹

服务端保存 skill_version、schema_version、规则内容哈希、模型/Provider 版本、request_id、输入上下文哈希、图片哈希、计划/工具 ID、时延、内部成本、停止原因。成本无供应商依据时标为未知，不写成已核验货币成本。

只记录可审计的理由和结果，不要求模型输出内部思维过程。报告、计划和图片版本只增不覆盖；选择较好版本需满足硬门槛并重检有效性，不能按最新或最高自评分直接替代。
