# 产品重构基线（M00）

- 记录日期：2026-11-07
- 仓库：`https://github.com/CHEN-Cowen/qiantubailian-commerce`
- 网站：`https://ccenyzd.cn/`
- 基线分支：`feat/commerce-commercialization` @ `3f0849b`（本地领先 origin 4 个提交）
- 重构分支：`product-rebuild-20261107`
- 交接包已入库：`docs/product-rebuild/`

## 运行环境

| 项目 | 实际值 | 仓库要求 | 结论 |
| --- | --- | --- | --- |
| OS | Windows | 无 | 可用 |
| Node | v24.20.0 | `>=22.22.2 <23` | 版本超出要求；语法检查与测试可运行，记录为环境差异 |
| npm | 随 Node | 无 | 可用 |
| 依赖 | `node_modules` 已存在 | `package-lock.json` | 未重装，未产生额外费用 |

## 基线检查

- `npm run check`：通过（后端/前端脚本语法检查）。
- `npm test`：**未全绿**，427 项中 425 通过、2 失败（日志 `.baseline-rebuild-test.log`）：
  1. `test/ai01.js`：离线评测实际读到 12 条 `label_status=confirmed` 保留集标签，测试仍断言“全部待人工确认、指标不可计算”。数据与断言不一致。
  2. `test/ai05.js`：取消后迟到结果未产生 `provider_late_result_ignored` 审计事件。取消收尾只轮询一次供应商，fixture 需要两次轮询才返回成功。
- 既有失败均为本地未推送的阶段 3–6 工作引入；与本次五处体验重构无直接冲突，但属于最终验收阻塞项，在 M00/M08 修复。

## 工作区既有改动（不属于本次重构，保留不提交）

- `.env.example`、`src/providers/index.mjs`、`test/m06.js` 内含主体保护相关改动。
- `frontend/app.js`、`frontend/index.html`、`src/api.mjs` 仅有行尾差异。
- 以上改动保持原样，不纳入本次模块提交。

## CI/CD

- 仓库内无 `.github/workflows`，未发现自动化 CI/CD 配置。
- 站点部署方式未在本仓库声明，本次不执行上线或改动生产配置。

## 可用凭据

- 未读取任何真实供应商密钥；测试使用 fixture / simulated 能力。
- 未执行真实支付、真实扣费或生产数据操作。
