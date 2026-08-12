# PR-104 Preflight

- repository: `lizhonghao31-crypto/dx-rework`
- base branch: `main`
- base SHA: `74bc5d2868a15b6427b449ea55069e7a9c4f0d98`
- working branch: `fix/detail-n01-first-entry-20260812`
- task scope: 修复待配置工序的新单首次进入订单详情时错误默认展示 N02，确保直接展示 N01 撤回与取消操作。
- allowed files: `apps/web/src/rework-detail-page.tsx`、`tests/unit/rework-initiation-workbench.test.ts`、`docs/engineering/pr-104-preflight.md`
- forbidden files: 除上述路径外的所有文件；尤其不得修改钉钉、权限、服务端接口、订单状态机、N08 与数据迁移。

## 行为边界

- 无显式 `node` 参数且订单状态为 `pending_process_configuration` 时，详情页默认选中 N01。
- 显式选择 N02、从 N02 待办进入，以及其他订单状态的默认当前节点行为保持不变。
- 继续复用现有 N01 权限判断、撤回/取消接口和审计逻辑。
