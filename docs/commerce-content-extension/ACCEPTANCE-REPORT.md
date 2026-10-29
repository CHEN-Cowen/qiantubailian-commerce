# E08 最终端到端验收报告

分支：`feat/commerce-commercialization`；运行环境：Windows，Node.js 22.22.2；记录时间：2026-10-29。

本报告按 [MASTER-PROMPT.md](MASTER-PROMPT.md) 第 10 节 15 类场景逐条对应实际验证方式，并区分**已实现 / 已模拟验证 / 已真实验证 / 未验证**。所有自动化验收使用真实 HTTP 与真实浏览器，但图片生成、OCR、视觉评审、支付与平台同步为模拟或未配置，不冒充真实外部验收。

## 1. 验收执行方式

| 类型 | 命令 | 说明 |
| --- | --- | --- |
| 全量回归 | `npm test` | 300 项（1 项为既有符号链接权限跳过）；Node 测试进程并发限制为 4，避免 sharp 重负载下连接抖动 |
| 语法检查 | `npm run check` | 全部 `.mjs` / 前端脚本 |
| 端到端脚本 | `npm run e2e` | 单账户完整链路 13 步，真实 HTTP + 模拟 Provider + 模拟支付 |
| 双租户多 SKU 验收 | `node --test test/acceptance.js` | 12 段、1 个测试，覆盖本报告第 2 节场景 1—12 的主路径 |
| 真实浏览器截图 | `node scripts/screenshots.mjs` | 真实 Chrome（headless）+ CDP，桌面 1440×1080 与手机 390×844 |

截图清单（`docs/experience-optimization/screenshots/`）：

| 文件 | 内容 |
| --- | --- |
| `01-home-desktop.png` | 桌面首页（待办、能力说明、项目概览） |
| `02-create-wizard.png` | 新建商品向导 |
| `03-projects.png` | 我的商品 |
| `04-workspace.png` | 商品素材工作区 |
| `05-brand-and-templates.png` | 品牌与模板 |
| `06-workbench.png` | 真实工作台与质检 |
| `07-workbench-text-edit.png` | 文字排版修改面板（免费） |
| `11-truth-change.png` | 商品事实弹窗「变更」区块 |
| `12-truth-sku-check.png` | 商品事实弹窗「SKU 核对」区块（未配置 OCR，视觉项保持未知） |
| `13-truth-question.png` | 商品事实弹窗「售前问题」区块 |
| `14-truth-explainer.png` | 商品事实弹窗「说明图」区块（已复核选版） |
| `15-workbench-dependencies.png` | 作品依赖面板（系统编译 + 人工关联） |
| `16-home-mobile.png` | 手机首页待办分组 |
| `17-truth-explainer-mobile.png` | 手机商品事实弹窗说明图区块 |
| `08-home-mobile.png` / `09-workbench-mobile.png` | 手机首页与工作台 |
| `10-auth-required.png` | 未登录访问被拒绝（生产式会话） |

每张截图的 SHA-256 均不同（脚本逐张打印哈希），不含相同的旧帧。

## 2. 15 类场景逐条对应

标记说明：**已实现**＝功能与文案存在；**已模拟验证**＝真实 HTTP/浏览器验证，外部能力为 mock/fixture；**未验证**＝本轮没有可复现证据。

| # | 场景 | 实际验证 | 结论 |
| --- | --- | --- | --- |
| 1 | 建商品与两个 SKU、确认属性/包含物、关联实拍、制作并导出 | `test/acceptance.js`：ACC-01 标准装（50g×1）与 ACC-02 双支装（100g×2），真实上传主体图，规格冻结、报价、建任务、发布 3 个版本、完整 ZIP 导出 + 按 SKU 导出；`test/e01.js`、`test/e02.js`、`test/e04.js` | 已模拟验证 |
| 2 | 改确认规格→依赖进清单、未知旧图待核对；纯文字不调用生图、不改其他选用版本 | `test/acceptance.js`：`/changes/preview` 纯文字报价 0、无 regenerate 项；`/changes` 执行后余额不变；主图 active_version 不变；`/replacement-todos` 生成并确认；`test/e03.js` 集成 | 已模拟验证 |
| 3 | 更新包装与单件/两件配置，要求照片与数量表达核对，不能只换字放行 | `test/e03.js`「换包装素材 → needs_new_photo，补拍后 completed」；`test/e06.js` 要求照片时的报价与 `PHOTO_SOURCE_REQUIRED`；**未**组合成「改包装 + 改件数」的真实浏览器完整流程 | 部分覆盖（自动化验证，浏览器流程未验证） |
| 4 | 批量更新部分失败、成功项保留、重试不重扣；重启恢复未完项与费用 | `test/e03.js`「重生成失败 → 部分失败保留成功项 → 重试成功且账本不重复扣费」；`test/acceptance.js` 第 10 段：同 storeDir 重启后登录，项目、`head_version`、余额与 `/api/todos` 摘要一致 | 已模拟验证 |
| 5 | 错归属、文字数量/单位/规格冲突可阻断；视觉疑点显示证据与未知，人工确认有范围 | `test/e04.js` 错配关联阻断/更正留痕/`SPEC_CONFLICT`/`FACT_REMOVED`；`test/acceptance.js` 未配置 OCR 时 `ocr_configured=false`、`VISUAL_UNAVAILABLE` 且必须带依据才能确认、确认绑定 `version_id` | 已模拟验证 |
| 6 | 修一个 SKU 不改另一个；导出正确组合；旧事实失效图限制 | `test/acceptance.js`：SKU 档案 v2 只改 ACC-02 卖点，ACC-01 仍为「舒缓维稳」；完整导出与按 SKU 导出路径前缀正确；`test/e03.js` 过期/失效闸口 | 已模拟验证 |
| 7 | 询问包含物/尺寸/规格差别：资料不齐先补、已有图先复用、需要时生成三种可编辑说明图 | `test/acceptance.js` 数量问题 → `needs_explainer/packing_list` → 确认；说明图创建、复核、内容下载哈希一致；`test/e05.js`、`test/e06.js` 三种图种与编辑守卫 | 已模拟验证 |
| 8 | 配送/支付/前台绑定问题正确分流、不伪造生图解决；无频次不写高频 | `test/acceptance.js` 物流问题 → `out_of_scope/logistics`，原文保留「输入的问题（未提供频次）」且不含「高频」；`test/e05.js` 五类分流 | 已模拟验证 |
| 9 | 补图后事实再次变化，新图能被找到；品牌更新不改历史和运行中任务 | `test/e03.js` 变更与替换待办；`test/e05.js` 补图建议；`test/e06.js` 事实变化被识别并确定性重排；**未**在真实浏览器里连续走「补图→再改事实→查找新图」 | 部分覆盖（自动化验证，浏览器链路未验证） |
| 10 | 免费说明图/排版不越底图权益；重复提交、回调、选版、恢复、导出不重复结算 | `test/e06.js` `SOURCE_NOT_ENTITLED` 与已发布版本继承；`test/acceptance.js` 幂等键重放、余额只扣一次；`scripts/e2e.mjs` 幂等与通知去重回归 | 已模拟验证 |
| 11 | 两个账户互相猜 ID 不能越权；写入与文件访问正确鉴权 | `test/acceptance.js` 第 11 段：项目/任务/问题组/说明图/核对问题/SKU 导出下载/SKU 核对写入一律 404，乙方待办为 0、余额不变；`scripts/e2e.mjs` 跨租户 404 | 已模拟验证 |
| 12 | 并发编辑不覆盖、断网/报价过期/余额不足/取消/超时/服务缺失有正确状态 | `test/e03.js` 旧 base 409、报价缺失/过期 409、余额不足 402、取消幂等；`test/e04.js` 版本冲突；既有 M 系列测试覆盖重试/超时；**未**做真实断网演练 | 已模拟验证（断网除外） |
| 13 | 桌面与手机真实浏览器走通三个完整流程，保存关键截图；模拟与真实分开 | `scripts/screenshots.mjs` 生成 17 张真实 Chrome 桌面/手机截图，逐张不同；**三条完整业务流程未在浏览器内逐步点击完成**（业务闭环由 `scripts/e2e.mjs` 与 `test/acceptance.js` 通过 HTTP 验证）；`/api/provider/capabilities` 明确 `simulated` / `acceptance=simulated_only` | 部分覆盖（截图为真，流程未全浏览器化） |
| 14 | 原有首次制作、复用、单张修改、质检、额度、导出回归；项目必需检查 | `npm run e2e` 13/13；`npm test` 全量；`npm run check`；既有 M03—M14、R01—R12、fixes 测试保留 | 已模拟验证 |
| 15 | 外部替换仅在用户确认时提示、不显示平台成功；日志/截图/仓库无私人客服记录、会话或密钥 | 导出与替换包文案「不会自动同步平台」「需你手工替换」；截图使用临时测试账户与虚构商品；仓库无 `.env` 或密钥 | 已实现 |

## 3. 本轮发现并修复的问题

1. **说明图区块真实浏览器不可用**：`renderExplainerForm` 把已 `join` 的字符串再次 `.join`，抛 `TypeError`，弹窗内「说明图」永远停在「正在读取说明图…」。修复为直接插入 `kindOptions`，并在 `test/ui-contract.js` 增加回归断言。
2. **截图相同与弹窗未打开**：截图脚本在模块脚本完成前就点击/派发事件，负载高时截到旧帧；同时固定 Chrome profile/端口会接上残留浏览器。改为等待 `document.readyState=complete`、等待真实按钮出现、截图前等两帧、每轮使用全新临时 profile 与空闲调试端口，并对导航失败重试。
3. **全量并行下 4 项集成测试连接失败**：E02/E03/E04/acceptance 在选择等待任务状态时出现 `fetch failed`，单独/串行重跑 24/24 通过。`npm test` 并发限制为 4，断言未放宽。

## 4. 真实外部服务边界（未验证）

| 能力 | 当前状态 | 说明 |
| --- | --- | --- |
| 生图模型 | 未配置，fixture 模拟 | `scripts/fixture-provider.mjs` 声明 `simulated: true`、`acceptance: 'simulated_only'`；截图与自动化均使用模拟图 |
| OCR | 未配置 | `ocr_configured=false`，视觉/文字项保持未知并进入人工复核，不伪造识别结果 |
| 视觉评审模型 | 未配置 | `VISUAL_UNAVAILABLE` 保持 review，需人工确认并留依据 |
| 微信支付 | mock | 仅演练下单/结算；真实商户 API 未验收 |
| 平台同步/外链替换 | 未实现 | 只生成替换清单与下载包，不显示平台成功 |
| 真实设备与网络 | 未覆盖 | 手机为 Chrome 设备模拟；未做真实断网、弱网与真机测试 |

以上未验证项不得对外表述为生产可用、平台合规或经营收益成立。
