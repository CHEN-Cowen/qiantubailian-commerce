# 阶段 1 交付报告：商品保真

日期：2026-11-05
阶段：P1（商品保真），对应 `docs/ai-development/STAGE-PROMPTS.md` 阶段 1。
基准：分支 `feat/commerce-commercialization`；工作区原有未提交修改 `frontend/app.js`、`frontend/index.html` 保留未动。
真实服务验收：**无**。未调用真实视觉模型、OCR 或支付；Provider 默认为 mock，真实生图与真实主体保护效果仍未验收。

## 1. 本阶段做了什么

新增纯函数模块 `src/product-context.mjs`，把商品上下文从"能上传"推进到"能冻结、能解释缺什么"：

| 能力 | 函数 | 说明 |
|---|---|---|
| 单张素材可用性 | `inspectAssetUsability({ asset, bytes })` | 真实解码（PNG 走 `decodePng`，JPEG/WebP 读头部尺寸）、尺寸与最短边、主体掩码来源、可执行补拍提示 |
| 项目级上下文审计 | `auditProductContext({ project, assets, truth, usability })` | 角色是否足够、错 SKU、风格图冒充主体/作为事实来源、事实引用素材失效、包装事实缺包装素材、重复素材 |
| 上下文冻结 | `buildContextBinding({ project, assets, truth, brandKitVersion, spec })` | 冻结项目 / SKU / 事实版本与哈希 / 生效素材版本 / 品牌版本 / 规格版本，产出稳定 `context_hash` |
| 合成保真度 | `auditCompositeFidelity({ composite })` | 边缘、阴影、透视固定 `unverified` + `needs_review: true`，给出人工复核依据 |

接入点（只增加记录与展示，不新增硬拒绝路径）：

- `src/api.mjs`
  - `GET /api/projects/:id` 新增 `asset_audit`、`asset_usability`、`context_binding`；品牌版本取当前规格引用的那一版；详情页不读二进制，解码状态如实标为 `unverified`。
  - `POST /api/projects/:id/assets` 响应新增 `usability`（上传时真实解码，含 `retake_hints`）。
- `src/jobs.mjs` `createRun`：在既有能力闸口之后，把 `product_context`（绑定、审计结论、补拍请求）写入 run 记录；原有拒绝路径（错 SKU / 风格图冒充主体 / 无主体真实 Provider）保持不变。
- `src/m07.mjs`：`SUBJECT_ALIGNMENT` 的 evidence 追加 `fidelity`（三项均 `unverified`），检查状态仍为 `unknown`，不新增断言通过。

## 2. 验收场景与证据

| 场景 | 实现位置 | 预期与实际 |
|---|---|---|
| 主体误改 | `src/m06.mjs` 既有像素核对 + `auditCompositeFidelity` | 掩码内逐像素核对仍是唯一 `pass` 依据；边缘/阴影/透视只能待复核。真实 Provider 侧主体保护仍为 `unknown` |
| 错 SKU | `auditProductContext` 与既有 `validateTruthInput` / `computeReadiness` | 事实 SKU 与项目不一致 → `SKU_MISMATCH` blocker，创建与审计两处一致 |
| 风格图冒充主体 | `auditProductContext` 与既有 `buildReferencePlan` / `checkSubjectProtection` | 只有风格图 → `STYLE_CANNOT_BE_SUBJECT` blocker + 补主体请求；既有闸口继续拒绝真实 Provider |
| 包装变化缺新素材 | `auditProductContext` + 既有 `change.mjs` | 关键包装事实无包装素材 → `PACKAGING_FACT_WITHOUT_ASSET`；关联素材变化 → `needs_new_photo` |
| 不可解码 / 低分辨率 | `inspectAssetUsability` | 不可解码为 blocker；低分辨率只提示补拍（保留可保存行为） |
| 上下文失效 | `buildContextBinding` | 素材替换、事实更新、品牌/规格变化都会得到新 `context_hash` |

新增测试 `test/ai02.js`（7 项）：

1. 素材可用性：可解码、低分辨率、损坏 JPEG、无矩形 JPEG 主体、已标注矩形、尺寸未知；
2. 上下文审计：风格图冒充主体、错 SKU、风格图事实来源、事实引用素材已替换、完整上下文 `can_bind: true`；
3. 包装变化：关键包装事实缺包装素材 + `change.mjs` 判定 `needs_new_photo`；
4. 上下文绑定：可复现、素材替换换哈希、事实更新换哈希、品牌/规格变化换哈希；
5. 合成保真度：三项固定 `unverified`，未合成时 `not_applicable`；
6. HTTP：上传返回可用性与补拍提示、项目详情返回绑定与审计、主体替换后哈希变化、跨租户 404；
7. HTTP：只有风格图时 `can_bind: false` 且 `readiness` 仍不可生产。

## 3. 验证结果

环境：Node `v22.22.2`（`runtime-tools/node-v22.22.2-win-x64`）。

| 命令 | 结果 |
|---|---|
| `node scripts/check.mjs` | 97 个文件语法通过 |
| `node test/ai02.js` | 7 通过 / 0 失败 |
| `node test/m06.js` | 13 通过 / 0 失败 |
| `node test/m07.js` | 12 通过 / 0 失败 |
| 全量 `npm test` | 321 项、通过 320、失败 0、跳过 1、耗时约 473s |

全量回归首次运行全部通过。另有一次重复的并发全量运行（同时跑两份套件）出现 1 项「真实子进程启动 / SIGTERM」失败，属已知的重资源并发抖动；单独运行时通过。后续回归请只跑一份。

## 4. 仍未验收与边界

- **真实视觉效果未验收**：没有真实生图模型输出，主体误改、边缘白边/锯齿、阴影方向、透视一致性的实际表现都未对照真实图。`auditCompositeFidelity` 只声明"需要复核"，不是验收结论。
- **真实 Provider 掩码能力未验收**：Seedream Adapter 仍声明 `supports_mask=false`；真实服务未调用。
- **详情页解码状态为 `unverified`**：为不阻塞项目详情读取，不在详情页重读二进制；上传时已做真实解码，两者在响应里分别标注。
- **审计不阻断生产**：`can_bind` 只进入任务记录与项目详情，没有新增创建阶段的 422 拒绝；是否升级为闸口需下一阶段结合真实数据决定。
- **品牌绑定依赖规格**：项目本身没有品牌字段，绑定取当前冻结规格 `brand_kit`；没有规格时 `brand: null`。

## 5. 下一阶段入口（P2 商品图评审）

按 `STAGE-PROMPTS.md` 阶段 2：接入 `commerce-image-reviewer`，实现最小多模态 Adapter、规则装配、实际图像输入、结构与语义校验、服务端元数据与报告映射；新检查追加到现有 QA，不覆盖原始证据；前端展示检查状态、证据与未知原因；先只评审、不自动修订。真实样本人工对照验证，真实视觉效果继续标"未验收"。
