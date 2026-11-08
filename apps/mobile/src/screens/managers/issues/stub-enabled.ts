// 【桩】经理 issue 的内存桩只在界面预览里启用；手机包里关着，控制台照旧四类（M1 接上核心后删掉）。
import type { ManagerIssueStubScene } from '../../../../../../packages/core/src/manager-issues-stub.mts'

export const ISSUE_STUB_ENABLED = false
export const ISSUE_STUB_SCENE: ManagerIssueStubScene = 'default'
