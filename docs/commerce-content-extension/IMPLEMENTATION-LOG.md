# 实施记录：商品内容维护扩展（E00—E08）

分支：`feat/commerce-commercialization`
记录规则：每个模块记录目标、实际实现、真实测试、失败修复、外部未验收项与提交/推送状态。提交号在下一条记录补入。

## 模块 E00：最新基线、原任务验收衔接与接口契约

### 基线事实（2026-10-28 实测）

- 本地与远端 `origin/feat/commerce-commercialization` 均为 `48642e9`（pull 后工作区干净，无未提交文件）。
- 原体验优化模块 00—07 已有提交与记录（`d54946d` 阻断修复 → `0a51042` 实施记录），本轮在此基础上增量扩展，不重做。
- 运行环境：Windows，Node.js 22.22.2（`C:\Users\cchen\AppData\Local\Temp\node22\node-v22.22.2-win-x64\node.exe`；PATH 上的 v24 与 `engines` 声明 `>=22.22.2 <23` 不符，本轮所有测试显式使用 Node 22）。
- 外部能力边界保持原状：真实生图模型未配置（`QTB_PROVIDER=mock`）、OCR 未配置端点、真实收款关闭（`QTB_ENABLE_REAL_PAYMENTS=0`，无商户号）。本轮不因扩展而改变这些边界。

### 基线实测证据（本轮亲自执行，非沿用历史数字）

- `npm run check`：语法检查 75 个文件通过。
- `npm test`（Node 22.22.2）：247 项，246 通过 / 0 失败 / 1 跳过（符号链接权限），退出码 0，约 140 秒。
- `npm run smoke`：真实子进程启动 + HTTP 健康探测 + SIGTERM 退出通过。
- `npm run e2e`：13 个步骤全部通过（注册/额度/CSRF/幂等/文字修改免费/单张重生成 1 点/导出勾稽/跨租户 404/绿色设计系统）。

结论：首次制作、商品品牌复用、文字排版修改、单张重生成、权益与导出链路当前可用，可作为本轮复用基础。

### 需求映射（本轮扩展 → 复用基础）

| 本轮需求 | 复用的既有能力 | 缺口 |
| --- | --- | --- |
| 商品/SKU/包含物档案（E01） | `projects` + `truth_versions`（版本化事实、乐观锁） | 项目当前只有单一 `sku` 字符串；无 SKU 实体、差异属性、包装包含物结构 |
| 图片依赖与导出追踪（E02） | `runs.versions[]`、`generation_records`、`exports`、`quality_reports` | 无图片版本→事实字段/素材/SKU 的依赖记录；导出无渠道标签与替换待办 |
| 变更更新助手（E03） | 文字排版修改（免费重合成）、单张重生成（按张计价）、版本只增 | 无变更单、影响清单、分类处理、批量部分失败重试、替换待办 |
| SKU 防串图（E04） | QA 报告结构（检查项/证据/人工复核）、素材归属 | 无三层核对（归属/结构/视觉候选）与按 SKU 导出 |
| 售前问题与补图（E05/E06） | 事实编译文字层、本地合成、导出 | 无问题组、分流、三种说明图模板、采用反馈 |
| 费用与幂等（E07） | 额度预留/结算/释放、幂等键、乐观锁、租户隔离、CSRF | 新动作需沿用同一账本与幂等机制；免费排版不扣额度 |

### 共用对象与接口契约（本轮统一口径）

新增存储表（追加，不改 `schema_version`，旧数据缺表按空表处理）：

| 表 | 内容 |
| --- | --- |
| `sku_profiles` | SKU 档案：稳定内部 ID、所属项目、商家编号、差异属性、包含物、确认状态、版本、乐观锁 `base_version` |
| `image_dependencies` | 图片版本依赖：对象（run+deliverable+version）、依赖项（事实字段 key/素材/品牌/SKU）、证据类型（`deterministic`/`ocr_candidate`/`manual`/`unknown`）、版本快照 |
| `change_orders` | 变更单：项目、基准事实版本、新事实版本、逐字段差异、状态机、影响清单快照、逐项任务、费用 |
| `check_issues` | SKU 核对问题：层级（ownership/structure/visual）、证据、严重度、状态、人工复核记录（绑定版本） |
| `question_groups` | 售前问题组：脱敏输入、归类、适用 SKU、人工来源/频次（可选）、匹配结论、缺口清单 |
| `explainer_plans` | 补图方案：问题组、图种（packing_list/size/sku_compare）、事实依据快照、排版提纲、报价、结果版本、采用反馈 |
| `replacement_todos` | 旧导出替换待办：导出记录、渠道标签、状态、用户确认者与时间（无平台回执语义） |

接口语义（名称可微调，语义不变；全部租户隔离 + 会话/CSRF；写操作幂等键）：

| 操作 | 路径 | 要点 |
| --- | --- | --- |
| SKU 档案读写 | `GET/PUT /api/projects/:id/skus` | 版本化、乐观锁；单规格简化返回 |
| 变更预览 | `POST /api/projects/:id/changes/preview` | 只算差异与候选影响，不触发生成 |
| 确认变更单 | `POST /api/projects/:id/changes` | base_version 冲突 409；生成影响清单 |
| 变更单查询/执行/重试 | `GET /api/changes/:id`、`POST .../execute`、`POST .../retry` | 逐项状态；成功项不重试不重复扣费 |
| 替换待办 | `GET /api/replacement-todos`、`POST /api/replacement-todos/:id/confirm` | 只记录“商家确认已替换”，不写平台同步 |
| SKU 核对 | `POST /api/projects/:id/sku-checks` | 三层结果分列；视觉服务缺失标 `unavailable` |
| 核对问题处理 | `POST /api/check-issues/:id/resolve` | 有范围的人工复核，绑定版本 |
| 问题分析 | `POST /api/projects/:id/questions/analyze` | 归类建议+已有图+缺口；不编造事实 |
| 补图方案/执行 | `POST /api/question-groups/:id/explainer-plans`、`POST /api/explainer-plans/:id/execute` | 确定性排版免费；需生图先报价 |
| 采用反馈 | `POST /api/explainer-plans/:id/feedback` | 记录采用/未采用原因，不声称经营收益 |
| 按 SKU 导出 | `POST /api/projects/:id/sku-exports` | 按 SKU 目录+清单；不混入其他 SKU/失效版本 |

### 兼容旧数据策略

- 旧项目没有 SKU 档案：读取时按“单规格、未建档”处理，提供建档入口；不批量伪造档案。
- 旧图片没有依赖记录：`image_dependencies` 查无记录时返回 `evidence: "unknown"`，进入“待核对”，不显示“无需更新”。
- 旧导出记录无渠道标签：`channel: null`，可补登记；不产生替换待办的回填伪造。
- 新表全部为追加式；所有版本对象只增不改，沿用 `base_version` 乐观锁。

### 状态口径（互不替代）

事实确认、变更处理、图片质量、用户选用、付费权益、外部替换是六个独立状态维度；任一维度通过不推导其他维度通过。前端展示不合并。

### 未验证 / 边界

- 真实模型、OCR、视觉检查、真实收款：未授权/未配置，本轮保持关闭；相应代码路径以契约测试覆盖，效果单列未验收。

### 提交与推送

- 提交：`d59e549`（docs(e00): 商品内容维护扩展基线核验、需求映射与接口契约）
- 推送：`origin/feat/commerce-commercialization` 已核对包含 `d59e549`（ls-remote 确认）。
- 备注：仓库本地配置 `http.proxy` 为空导致直连 github 失败；推送用命令级 `-c http.proxy=http://127.0.0.1:10808` 覆盖，未改任何 git 配置。

## 模块 E01：共用商品、SKU与包装包含物服务

### 实际实现

1. 新表 `sku_profiles`（`src/store.mjs`，追加式，旧数据缺表按空表迁移）。
2. 新文件 `src/sku.mjs`（纯函数）：`validateSkuProfilesInput`（商家编号同项目内大小写不敏感去重、差异属性值禁止留空、包含物 quantity>0 + 单位必填 + included 布尔 + source∈user_input/asset 且 asset 来源必须指向该项目生效中且非 style 素材）；显式单位换算表（体积 ml/L、质量 g/kg/mg、长度 mm/cm/m 换算到基准；计数单位只做别名归一「个≡件」，不同计数单位互不等价；表外单位 422 UNKNOWN_UNIT）；`normalizeQuantity`/`unitsEquivalent`（500ml≡0.5L、1kg≡1000g）；`diffSkuProfiles`（按稳定内部 ID 对齐的逐 SKU 字段级差异，供 E03 复用）；`simplifiedSkuView`（无档案项目返回 derived 视图，不伪造已确认档案）。
3. `src/api.mjs` 路由：`GET/PUT /api/projects/:id/skus`、`GET .../skus/versions[/:version]`；全部走 `findProject` 租户隔离（跨租户 404）；PUT 乐观锁（base_version≠project.sku_head_version → 409 VERSION_CONFLICT）；confirm=true 时存在未确认 SKU → 409 CONFIRMATION_BLOCKED；版本只增、稳定内部 ID `sku_xxx` 与商家编号分离；权限沿用 projects 默认 project:read/write。
4. 前端：商品事实弹窗新增「SKU 档案」板块（`frontend/real-data.js` + `frontend/api.js` + `frontend/m03.css`）：列表/建档入口/编辑表单（可加删 SKU、属性行、包含物行，来源可选生效素材）/保存草稿与全部确认/版本历史/409 中文提示；沿用绿色设计系统，移动端两列降列不溢出。

### 测试证据（Node 22.22.2）

- `npm run check`：77 个文件通过；`node --test test/e01.js`：12/12 通过（纯函数 7 + HTTP 集成 4 + 旧数据兼容 1）。
- 全量 `npm test`：259 项，258 通过 / 0 失败 / 1 跳过（既有符号链接项），连续两次通过。

### 未验证 / 边界

- E01 不消耗生图额度（建档与查询为免费操作）；未涉及计费路径。
- 前端表单为手工 DOM 实现，真实浏览器截图验收统一在 E07/E08。
- 历史版本中引用的素材后续被替换的失效检测属 E02 依赖记录范围，本模块不回填。

### 提交与推送

- 提交：`10f9eac`（feat(sku): E01 商品SKU档案与包装包含物服务）
- 推送：已核对远端包含 `10f9eac`。

## 模块 E02：图片依赖、版本与导出追踪服务

### 实际实现

1. 新表 `image_dependencies`（一个 run+deliverable+version 一条记录，entries 含 kind∈fact/asset/brand/sku/text_layer、evidence∈deterministic/ocr_candidate/manual、deterministic 带 source_version 快照）与 `export_channels`（渠道标签 + history）。
2. 新文件 `src/depgraph.mjs`：`compileDependencies` 从冻结 spec 快照/事实版本/SKU 档案编译确定依赖；`mergeManualEntries` 按 kind:ref 去重；无编译依据返回 null（不伪造依赖）。
3. `src/jobs.mjs` 三个挂钩点：生成成功版本、文字修改新版本、单张重生成新版本落库时编译写入；无 spec 快照的 legacy 版本跳过（查询侧按 unknown）。**附带修复既有 bug**：`reportSnapshotContext` 原用 `kit?.version`，而 brand_kits 实际字段为 `head_version`，导致带品牌套件的 QA 报告恒 stale、无法复核/导出；已改 `kit?.head_version ?? null`。
4. 路由：`GET /api/runs/:id/dependencies`（无记录版本标 unknown，不显示「无需更新」）、`GET/POST /api/runs/:id/deliverables/:did/dependencies`（人工关联必填 reason、ref 范围校验）、`DELETE .../dependencies/:entryRef`（deterministic 拒绝 409 DEPENDENCY_LOCKED，manual 可删并留 removals 审计）、`PUT/GET /api/exports/:id/channels`（标签去重 ≤8 个）、`GET /api/projects/:id/assets/:aid/dependents`。全部租户隔离。

### 测试证据（Node 22.22.2）

- `node --test test/e02.js`：3/3 通过（纯函数编译、真实 HTTP 集成全链路、旧数据 unknown 兼容）。
- `npm run check`：79 个文件；全量 `npm test`：262 项，261 通过 / 0 失败 / 1 跳过（既有符号链接项）。

### 本轮调试修复

1. 人工关联测试断言修正：同 ref 已被编译为 deterministic 时 manual 去重跳过（设计如此），改用全新 ref 断言。
2. DELETE 无 body 时 readJson 先抛 400：改为仅 content-length>0 才读 body，缺 reason 正确返回 422。

### 未验证 / 边界

- `ocr_candidate` 档位结构与呈现已支持，但 OCR 未配置时无产生路径，仅有结构测试。
- 依赖记录的前端展示在 E07 统一联调；`export_channels` history 仅断言 labels 更新行为。

### 提交与推送

- 提交：见 E03 记录开头补入。
