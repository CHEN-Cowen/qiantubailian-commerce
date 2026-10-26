# 千图百炼 UI 升级接手包（UI01—UI04）

日期：2026-10-27
用途：把本文件和第 0 节提示词交给其他软件，在 M01—M12 全部完成的基础上做界面升级。
当前仓库：https://github.com/CHEN-Cowen/qiantubailian-commerce
当前基线：`master` 分支，SHA `3d1ab82`（M12 提交：结果回流、实验口径、支付闸口、可观测性与租户备份恢复）

> 本次只做界面升级，不改任何业务逻辑。四个任务按顺序分阶段执行：UI01 视觉换肤 → UI02 收演示标记 → UI03 首页价值叙事区 → UI04 真实样例图替换占位。

---

## 0. 直接复制给其他软件的提示词

```text
你现在接手“千图百炼”项目的 UI 升级，按 UI01 → UI02 → UI03 → UI04 顺序分四个阶段开发，全部完成并通过最终验收后结束。

仓库：https://github.com/CHEN-Cowen/qiantubailian-commerce
分支：master
当前基线 SHA：3d1ab82（M01—M12 已全部完成并推送）

先完整阅读 docs/千图百炼_UI升级接手包_UI01-UI04.md。再读 docs/千图百炼_新产品PRD_V1.0.md 的产品定位部分。不要重写现有系统、不要另起项目，本次只做界面升级。

任务顺序：
UI01 视觉换肤：科技蓝换暖橙色系（主色 #FF5A2E + 暖中性底），界面上所有英文 eyebrow 标签改中文
UI02 收演示标记：清除用户可见文案中所有 M0x 模块编号、MOCK、REAL DATA 字样，演示/真实数据区分改为产品化文案
UI03 首页价值叙事区：首页新增“原图 → 生成图 → QA 通过标记”效果展示区，传达“交付能上架的图”
UI04 真实样例图替换占位：用真实模型生成的样例图替换 CSS 占位商品图，新增图片必须同步 src/server.mjs 的 STATIC_FILES 白名单与对应测试

强制规则：
1. 一次只做一个任务，严格按顺序。动手前先完整读 frontend/style.css、m03.css、m04.css、m05.css、viewport.css、index.html 的现状。
2. 只改 frontend/，不改 src/ 业务逻辑；唯一例外是 UI04 新增图片文件时同步 src/server.mjs 的 STATIC_FILES 白名单和 test/ 中对应静态资源测试。
3. 不引入新依赖、不引入 UI 框架、不引入字体 CDN、不加构建步骤。
4. 色值与文案必须逐条对照接手包第 2 节的映射表，不要自行发明色值或改写产品文案方向。
5. 每个任务完成后先自检：npm test、npm run check 全绿；npm start 后用浏览器逐页走查（首页、商品项目、素材与版本、模板与品牌、项目详情、全部 dialog），并在 375px 宽视口核对不破版；按任务验收标准 grep 审计。发现问题先修复再复测。
6. 自检通过后自动 commit 并 push（用户已长期授权，无需询问），提交信息格式 feat(ui0x): 中文描述，一个任务一个提交；核对远端 SHA 与本地一致后直接开始下一任务，全程不需要向用户确认。
7. 数据诚实：演示数据不得说成真实数据，不得编造统计数字，不得声称平台合规，样例图必须注明“真实模型生成样例”且来源可说明。
8. 四个任务全部完成后做一次完整端到端走查，输出总结报告：环境与命令、每个任务的改动文件清单、每页走查结论、测试结果、遗留限制。

开始前先回复：你读到的当前 SHA、你对四个任务顺序与各自范围的理解、你准备开始 UI01 前的改动清单。然后直接开始 UI01，无需等用户确认。
```

---

## 1. 为什么要做这次升级

用户反馈与竞品分析结论：

1. 当前 `#246BCE` 科技蓝 + 英文 eyebrow + 冷灰底是标准 B2B SaaS 后台风，与“帮中小电商商家做商品图”的产品气质不匹配。
2. 但产品核心场景是生产工具：工作区不能全站大促红——周围环境色会干扰对商品图颜色的判断。**决策为方案 C“分层双轨”**：营销层（首页标题、按钮、强调色）用电商暖橙，工作区底色保持中性（但从冷灰改暖灰）。
3. 界面上暴露大量工程标记（MOCK、M0x 模块编号、REAL DATA），观感是“半成品”而非“产品”。
4. 首页是纯仪表盘，对新商家没有回答“为什么用你”，缺一个价值叙事/效果展示区。
5. 所有商品图是 CSS 画的占位色块，而电商图工具的说服力来自真实图片质量。

禁止事项：不得把全站改成红橙大促海报风；不得删除演示/真实数据的诚实区分，只能把它改得更产品化。

## 2. 设计规范（所有任务共用）

### 2.1 色彩 token 映射表（UI01 执行）

`frontend/style.css` 的 `:root` 变量与各 css 硬编码按此替换。允许把 `--blue` 更名为 `--primary`（需同步所有 `var(--blue)` 引用，位于 style.css / m03.css / m04.css / m05.css），也可以保留变量名只换值；推荐更名。

| 旧值 | 用途 | 新值 |
|---|---|---|
| `--blue: #246bce` | 主色 | `--primary: #FF5A2E` |
| `--blue-dark: #1755aa` | 主色 hover | `--primary-dark: #E6481F` |
| `#e6efff`（brand-mark 底）、`#e8effb`（avatar 底）、`#eaf2ff`、`#edf4ff`（选中态底）、`#f8fbff`（推荐卡底） | 品牌浅底 | `#FFF1EB` |
| `--purple: #6d5bd0` | 辅助强调（任务图标、推荐标签、费用数字） | `--accent: #E8890C` |
| `#f0edff`（推荐标签底） | 辅助强调浅底 | `#FFF6E5` |
| 新增 | 大促点缀（角标、限时、推荐） | `--gold: #FFC53D` |
| `--ink: #172335` | 主文字 | `#2A2420` |
| `--muted: #657184` | 次级文字 | `#6E655D` |
| `--faint: #8a96a6` | 弱文字 | `#9C9188` |
| `--line: #e4e9f0` | 边框分隔 | `#ECE6DF` |
| `--cloud: #f7f9fc` | 页面底色 | `#FAF8F5` |
| `#d4deea`（secondary 按钮边框）、`#e6ebf2` | 冷灰边框 | `#E5DED6` |
| `#eef2f6`、`#f1f3f6`、`#f2f4f7`、`#eef2f7`、`#f3f6fa` | 冷灰浅底（分段控件、进度条底等） | `#F3F0EB` |
| `#fbfcfe`、`#f7f9fc`（表头、抽屉内底） | 冷白 | `#FBF9F6` |
| `#aac9f5`、`#8fb9f2`、`#a9c8f4`、`#b9d2fa`（hover/选中边框） | 蓝色 hover 边框 | `#FFB08A` |
| `#9bc2ff`（焦点环）、`#8fb9f2` 等 outline | 焦点可见性 | `#FFC9AD` |
| `#246bce2b`（主按钮阴影） | 品牌阴影 | `rgba(255,90,46,.17)` |
| `#263f5c05`、`#304a6815`、`#1c2b401c`、`#12203352`、`#15233740`、`#172335`（toast 底） | 蓝灰阴影/遮罩/深底 | 统一换暖深底 `#241E19` 系（遮罩可用 `rgba(36,30,25,.32)`） |
| 状态色 `--green/--amber/--red` 及其浅底 | 语义状态 | 保持不变 |

其他规则：

- `index.html` 中 brand-dialog 的 placeholder `#246BCE` 顺手改为 `#FF5A2E`。
- 首页 `h1` 不整标题渐变：保持 `--ink` 深色，把关键词“能上架的视觉资产”包一层 `<span>` 用渐变强调：`background: linear-gradient(120deg, #D63A12, #FF7A3D); -webkit-background-clip: text; background-clip: text; color: transparent;`（需在 index.html 加一个纯静态 span，允许）。
- `m03.css` 的 `.real-badge`（`#eaf2ff` 底）同步换新浅底 + `--primary` 文字。
- 完成后审计：在 frontend 目录 css 文件中 grep `#246bce|#1755aa|#6d5bd0|#e6efff|#e8effb|#eaf2ff|#edf4ff|#f8fbff|#aac9f5|#8fb9f2|#a9c8f4|#b9d2fa|#9bc2ff|#f0edff` 应为 0 处（index.html 的 placeholder 除外，已要求修改）。
- 对比度底线：正文文字对比 ≥ 4.5:1，大字号 ≥ 3:1。`#FF5A2E` 作按钮底配白字可以；作小号文字色时须改用 `#D63A12`。

### 2.2 eyebrow 中文化对照表（UI01 执行）

只改文案内容，保留小号加宽字距的样式风格。index.html 内全部处理：

| 现文案 | 改为 |
|---|---|
| `QUICK CREATIVE FACTORY · 快捷创意工厂` | `快捷创意工厂` |
| `PRODUCT PROJECTS` | `商品项目` |
| `ASSET LIBRARY` | `素材与版本` |
| `BRAND LIBRARY` | `模板与品牌` |
| `PRODUCT PROJECT / MC-50` | `商品项目 · MC-50` |
| `COMMERCE QA` | `质量检查` |
| `PROFESSIONAL MODE` | `专业模式` |

注意：`REAL DATA · 服务端持久化`、`M0x · ...`、`MOCK · ...` 属于 UI02 的标记清理范围，UI01 不要动。

### 2.3 字体

- 不引入字体 CDN、不新增依赖。body 字体栈调整为：`"PingFang SC", "MiSans", "HarmonyOS Sans SC", "Source Han Sans SC", "Microsoft YaHei", system-ui, sans-serif`。
- 圆润亲和感靠暖色、圆角、间距与插画实现。如需自托管开源中文字体（如得意黑），必须等用户提供字体文件并确认授权后另开任务，本包不做。

## 3. UI01 视觉换肤

范围：`frontend/style.css`、`m03.css`、`m04.css`、`m05.css`、`viewport.css`（如有蓝色引用）、`index.html`（eyebrow 文案 + h1 关键词 span + brand placeholder）。不改 HTML 结构、不改类名、不改 JS。

步骤：

1. 按 2.1 表替换 `:root` 变量（含更名 `--blue` → `--primary`、`--purple` → `--accent`），全局同步 `var()` 引用。
2. 按映射表替换各 css 硬编码蓝色/冷灰/紫色。
3. 按 2.2 表中文化 eyebrow。
4. 落实 h1 关键词渐变 span。
5. 视觉抽查：主按钮、导航激活态、进度条、状态徽章（制作中）、任务卡图标与推荐标签、QA 分数、费用数字、抽屉与 dialog，确认无蓝色残留、无对比度问题。

验收：

- 2.1 的 grep 审计为 0。
- `npm test`、`npm run check` 全绿（纯样式与静态文案改动，不应影响测试；若测试断言了 eyebrow 文案，同步更新测试）。
- 浏览器逐页截图：首页、商品项目、素材与版本、模板与品牌、项目详情、全部 dialog；375px 视口不破版。
- 提交：`feat(ui01): 暖橙色系视觉换肤与界面文案中文化`

## 4. UI02 收演示标记

目标：用户可见界面上不再出现 M0x 模块编号、MOCK、REAL DATA 字样；演示与真实数据的区分保留，但文案产品化。类名、代码注释、console 前缀可保留不改。

逐条对照表（index.html）：

| 位置 | 现文案 | 改为 |
|---|---|---|
| 顶栏 | `MOCK · 全部指标与图片为示意` | `演示数据`（保留 chip 样式，改为可点击，点击打开数据说明 dialog） |
| 商品项目页 real-head eyebrow | `REAL DATA · 服务端持久化` | 删除该 eyebrow（h2 保留） |
| 商品项目页 h2 | `真实商品项目` | `我的项目` |
| real-badge | `M03 · JSON 持久化 · 单租户` | `自动保存 · 刷新不丢失` |
| real-note（商品项目页） | “以下列表与商品事实来自本机 runtime/ 存储与 /api/projects，刷新不会重置。下方演示区为 M02 mock，两者数据不互通。” | “以下项目与商品事实自动保存，刷新不会丢失。下方演示数据仅用于功能展示，与真实数据互不影响。” |
| real-divider | `以下为 M02 演示数据（mock，刷新即重置，不写入服务端）` | `以下为演示数据 · 刷新即重置` |
| real-note（real-data.js 空状态） | “尚未创建真实项目。点击…；下方 mock 演示区不写入任何真实数据。” | “尚未创建项目。点击「导入商品资料」或「新建项目」开始。” |
| 首页 real-projects 区（若 UI03 改动此处则顺势处理） | 同上原则 | 同上原则 |
| project-topline | `演示项目 · 数据为 mock` | `演示项目 · 刷新重置` |
| help-dialog eyebrow | `M03 · 项目与商品事实` | `关于数据` |
| help-dialog 正文 | “「商品项目」页顶部的真实项目来自服务端 /api/projects…带 MOCK 标记的区域仍是演示数据。生成、质检、费用与导出尚未接入（M05—M08）。” | “你的项目、素材、任务与导出记录会自动保存；带「演示数据」标记的区域仅用于功能展示，刷新即重置，不会写入你的真实数据。”（M05—M08 已实现，删除过时表述） |
| project-dialog eyebrow | `M03 · 真实数据` | 删除或改 `新建`（保留 h2） |
| project-dialog real-note | “项目写入本机 runtime/ 存储；同租户 SKU 重复会被拒绝且不覆盖原项目。” | “项目会自动保存；SKU 重复会被拒绝且不覆盖原项目。” |
| upload-dialog eyebrow | `M03 · 素材登记` | `上传素材` |
| truth-dialog eyebrow | `M03 · 商品事实与生产闸口` | `商品事实` |
| spec-dialog eyebrow | `M04 · 模板 / 品牌 / 平台规则` | `生产配置` |
| brand-dialog eyebrow | `M04 · 品牌基础套件` | `品牌套件` |
| run-dialog eyebrow | `M05 · 报价 / 额度 / 任务执行` | `生产任务` |
| flow-dialog eyebrow | `MOCK · 本页演示 / 刷新重置` | `演示流程 · 刷新重置` |
| 各 real-note 中 `runtime/`、`/api/...`、`M0x` 字样 | — | 去掉技术路径与编号，保留行为描述（如“自动保存”） |

逐条对照表（JS toast 与动态文案）：

| 文件 | 现文案 | 改为 |
|---|---|---|
| app.js | `仅换背景将在 M06 接入主体保护与实际生成` | `此为演示入口；请在「商品项目」中打开真实项目使用仅换背景` |
| app.js | `此页为 M02 演示项目，不写入真实商品事实；真实项目请在「商品项目」页打开商品事实` | `此页为演示项目，不会保存；真实项目请在「商品项目」页打开` |
| app.js | `修订任务将在 M08 接入版本对比与重新质检` | `演示页暂不支持修订；请在真实项目中使用自动修订` |
| app.js | `Prompt 为当前版本快照，手动修改将在 M08 生成新版本` | `演示数据，仅供查看` |
| app.js | `模型参数仅展示适配器快照，真实 Provider 将在 M06 接入` | `演示数据，仅供查看` |
| m04.js | `（模板推荐值，正式报价属 M05）` | `（模板推荐值，正式报价以冻结的生产配置为准）` |

验收：

- 在 frontend 目录 grep `M0\d|MOCK|REAL DATA|mock` ：index.html 与各 js 中用户可见字符串（innerHTML、toast、placeholder、title、aria-label）命中为 0；代码注释、类名（如 `.mock-badge`）、console 前缀允许保留。
- 顶栏“演示数据”chip 可点击且说明 dialog 内容更新正确。
- 逐页截图核对；`npm test` 全绿（文案断言如有需同步）。
- 提交：`feat(ui02): 演示标记产品化与模块编号清理`

## 5. UI03 首页价值叙事区

目标：在首页回答新商家“为什么用你”，传达核心卖点“不止生成好看的图，更交付能上架的图”。

实现要求：

1. 位置：home 视图内、`page-heading` 之后、`metric-strip` 之前，新增 `<section class="section-block showcase-block">`。
2. 布局：左右结构（≥900px），下方堆叠（<900px）。左侧文案，右侧 before/after 对比卡。
3. 左侧内容：
   - eyebrow：`为什么是千图百炼`
   - 标题：`不止生成好看的图，更交付能上架的图`
   - 卖点三条（图标用现有字符符号风格，颜色用 `--primary`/`--accent`）：
     - `商品主体锁定：真实素材保护与合成，生成不变形`
     - `包装文字与 Logo 精确保留，杜绝 AI 乱码字`
     - `平台规范与商品事实逐项检查，不合规不放行`
   - CTA 按钮：`创建新品上架包`（复用现有 `#new-project-button` 行为，可用 class 绑定或复制 id 逻辑时注意唯一性——推荐给现有按钮逻辑加 class 选择器）。
4. 右侧对比卡：`原图素材 → 生成图 → QA 通过标记条`。UI04 之前用现有 CSS 占位风格或 `assets/demo/image-01.jpg`（已在白名单）填充；标记条为三个小徽章：`主体一致`、`文字无误`、`尺寸规范`，下方一行小字：`流程示意 · 以演示数据展示`。
5. 数据诚实：不引入任何统计数字（如通过率、一致率百分比）；标记条必须带“流程示意”说明。
6. 样式直接写进 `style.css`（不要新增 css 文件，避免同步 STATIC_FILES 与测试）。
7. 响应式与对比度按 2.1/2.3 规范。

验收：首页截图 + 375px 视口；`npm test` 全绿；CTA 点击行为正确；无编造数字。
提交：`feat(ui03): 首页效果展示与价值叙事区`

## 6. UI04 真实样例图替换占位

现状：`frontend/assets/demo/image-01.jpg`、`image-02.jpg`、`image-03.jpg` 已存在且已在 `src/server.mjs` 的 `STATIC_FILES` 白名单中（注意单张约 1MB，偏大）。

要做：

1. 先确认 `data/demo.json` 与这三张图的现有引用关系，改动不得破坏既有引用。
2. 样例图扩充：目标 ≥ 6 张真实模型生成的商品样例（如护肤霜罐主图/卖点/场景、便携台灯、洁面泡沫），覆盖首页对比卡、项目卡封面、素材网格、项目详情画布。来源要求：真实模型（Seedream 等）生成或用户提供的授权素材，禁止网图；每张压缩到 ≤ 500KB，主图 1200×1200 或 1200×1500。
3. 替换点：
   - UI03 的 before/after 对比卡：`<img loading="lazy" alt="...">`，`object-fit: cover`。
   - 首页项目卡 cover（`.cover-skin`、`.cover-lamp` CSS 罐子）：换成 img 底图（保留 cover-tag 角标）。
   - 素材网格（`.asset-image` 系列）与项目详情画布（`.canvas-image`）：同上处理。
   - CSS 占位类保留为图片加载失败时的兜底背景色。
4. 每新增一个图片文件，必须同步：`src/server.mjs` 的 `STATIC_FILES` 数组 + `test/` 中静态白名单相关测试（先看现有测试怎么断言，逐条同步）。
5. 诚实标注：样例区域注明“真实模型生成样例”；任务指标、费用、额度仍为演示口径，不得混称。
6. 若拿不到足够的新样例图：用现有 3 张完成尽可能多的替换点，其余保留 CSS 占位，并在完成报告“遗留限制”中明确列出，不得伪造。

验收：替换点全部为真实图片且加载正常（含 375px）；`npm test`、`npm run check` 全绿；STATIC_FILES 与测试同步；文件体积达标。
提交：`feat(ui04): 真实样例图替换演示占位`

## 7. 通用硬性约束

- Node `22.22.2`（见 `.node-version`），原生 ESM，零外部依赖，原生 `node:test`。
- 常用命令：`npm test`、`npm run check`、`npm run smoke`、`npm start`（`http://127.0.0.1:3000/`）。
- 新增前端静态文件必须同步 `src/server.mjs` 的 `STATIC_FILES` 与相关测试；新增测试文件必须同步 `package.json` 的 `test` 脚本，否则不会执行。
- 本包只改 `frontend/`（UI04 例外：`src/server.mjs` 白名单 + test 同步）。不改业务域逻辑、不改 API、不改测试断言的业务预期。
- 不引入 UI 框架、构建工具、字体 CDN、新 npm 依赖。
- 数据诚实红线：演示数据不得说成真实数据；不编造统计数字；平台规则未经核验不得声称合规；样例图来源必须可说明。
- Git：一个任务一个提交，`feat(ui0x): 中文描述`；自检通过后自动 commit + push，无需用户确认；push 后核对远端 SHA 与本地一致。

## 8. 最终验收（四个任务全部完成后）

1. `npm test`、`npm run check`、`npm run smoke` 全绿。
2. `npm start` 后浏览器完整走查：首页、商品项目、素材与版本、模板与品牌、项目详情、全部 dialog、375px 视口。
3. 审计：css 无蓝色系残留（2.1 grep 列表）；用户可见文案无 `M0x`/`MOCK`/`REAL DATA`（UI02 grep 规则）。
4. 首页价值叙事区展示完整、CTA 可用、含“流程示意”标注。
5. 至少 3 个替换点使用真实样例图，白名单与测试同步，单张 ≤ 500KB。
6. 输出最终报告：环境、四个提交的 SHA、每页走查结论、测试结果、遗留限制与建议。区分“演示流程”与“真实前后端流程”，不得宣称可用于真实生产。
