// 界面预览（npm run preview）对着模拟核心：启用经理 issue 的内存桩，能新建、评论、改状态、改跟进。
// 几个 issue 场景（scenes.web.ts 里 manager-issues-*）按场景编号切桩的数据：空、旧设备、无权限、大量。
import type { ManagerIssueStubScene } from '../../../../../../packages/core/src/manager-issues-stub.mts'

export const ISSUE_STUB_ENABLED = true
const scenes: Record<string, ManagerIssueStubScene> = {
  'manager-issues-empty': 'empty',
  'manager-issues-old': 'old',
  'manager-issues-forbidden': 'forbidden',
  'manager-issues-many': 'many',
}
export const ISSUE_STUB_SCENE: ManagerIssueStubScene =
  scenes[new URLSearchParams(globalThis.location?.search ?? '').get('scene') ?? ''] ?? 'default'
