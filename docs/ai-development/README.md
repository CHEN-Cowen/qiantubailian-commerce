# AI 升级开发交接包

适用版本：2026-11-05。状态：开发指令、运行时规则与协议材料已制作；应用尚未加载这些新 Skills，尚未进行真实图片效果验收。

## 给开发软件哪些文件

提供当前完整源码，重点包括：

- `docs/PRD-商品视觉AI工作流升级开发方案.md`：总体方案。
- 本目录：开发提示词、运行时装配约定、验收案例。
- `skills/commerce-image-reviewer/`：商品图评审 Skill、输出 Schema 与协议样例。
- `skills/commerce-image-refiner/`：商品图修订规划 Skill、输出 Schema 与协议样例。

交接可复制源码或传源码压缩包；排除 `.env`、密钥、`node_modules`、`runtime`、客户数据和不必要历史文件，保留 `.env.example`、锁文件和测试。真实素材另按授权提供。开发软件需要能访问源码，单独发送本文或简历不能完成开发。

## 使用顺序

1. 把 `DEVELOPER-PROMPT.md` 全文发送给开发软件。首次任务默认执行阶段 0，核查并进入可独立完成的准备工作。
2. 后续每轮发送 `STAGE-PROMPTS.md` 中对应阶段，并让软件读取 `RUNTIME-CONTRACT.md` 与 `ACCEPTANCE-CASES.md` 的相关部分。
3. 接入评审时使用 `runtime/reviewer-system.md`；接入修订时使用 `runtime/refiner-system.md`。按 `runtime/ASSEMBLY.md` 组装 Skill 正文、Schema、上下文和真实图像。
4. 每阶段要求实际改代码、做相关验证，并更新 `IMPLEMENTATION-LOG.md`；有外部依赖阻塞时完成独立工作，保留明确未验证项。

新增 Skills 为仓库内可携带目录。外部开发软件可读取它们，也可按自己的技能发现机制安装；产品服务端仍需编写加载与模型调用代码。无需将本项目注册为通用 Agent 平台，也不要求通过 MCP 调用应用已有 Provider。

协议示例是人工构造的合成数据，不是真实图片评审结果。Schema 负责形状约束；实际产品还须执行契约文档中的语义校验、权限校验与业务门槛。

在项目根目录用 PowerShell 7 执行 `./docs/ai-development/validate-materials.ps1` 可复验输出 Schema、合成样例和关键拒绝分支。该脚本仅检查交接材料，不能充当产品的运行时校验器或权限测试；接入开发必须另写对应应用验证。

## 最小展示里程碑

真实商品图 → 可定位的问题与证据 → 可执行的修订建议 → 人工触发处理 → 再评审。

先完成这个链路，再开放有限自动执行。套图 Skill 在单图协议稳定后开发，本包先提供其验收任务，不创建未经验证的额外编排 Skill。
