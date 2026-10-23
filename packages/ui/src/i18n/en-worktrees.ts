// 工作树的英文文案。键必须和 zh-CN-worktrees.ts 完全一致，多一句少一句都编译不过。
import type { Entry } from './types.ts'
import type { zhWorktrees } from './zh-CN-worktrees.ts'

export const enWorktrees: Record<keyof typeof zhWorktrees, Entry> = {
  'newSession.where': 'Where',
  'newSession.where.label': 'Choose where to work',
  'newSession.where.local': 'Local',
  'newSession.where.worktree': 'New worktree',
  'newSession.where.worktreeHint':
    'Creates a git worktree and branch on the device, so changes stay out of the project folder',
  'newSession.from': 'From',
  'newSession.from.label': 'Choose what to branch from',
  'newSession.from.default': 'Default branch ({branch})',
  'newSession.from.working': 'Current local state',
  'newSession.from.workingHint':
    'The project folder’s current commit, plus uncommitted changes and new files',
  'newSession.from.current': 'Current branch',
  'newSession.from.search': 'Filter branches',
  'newSession.creatingWorktree': 'Creating worktree…',
  'session.worktree': 'Worktree: {branch}',
  'session.worktree.removed': 'Worktree removed: {branch}',
  'info.worktree': 'Worktree',
  'info.worktree.from': 'from {base}',
  'info.worktree.removed': 'Removed',
  'worktree.base.working': 'local state',
  'worktree.base.head': 'HEAD at the time',
  'worktree.title': 'Worktree',
  'worktree.branch': 'Branch',
  'worktree.base': 'From',
  'worktree.removedNote':
    'The worktree folder was removed. The branch is kept and uncommitted changes were saved as a snapshot. Restore it to keep working.',
  'worktree.restore': 'Restore',
  'worktree.restoring': 'Restoring…',
  'worktree.terminal': 'Terminal',
  'worktree.copyPath': 'Copy path',
  'worktree.copied': 'Copied',
  'worktree.list.title': 'Worktrees on this device',
  'worktree.list.offline': 'The device isn’t connected, so worktrees can’t be listed.',
  'worktree.list.loading': 'Loading…',
  'worktree.list.failed': 'Couldn’t load worktrees: {reason}',
  'worktree.list.empty': 'No worktrees yet.',
  'worktree.list.actionFailed': 'That didn’t work: {reason}',
  'worktree.list.ownerGone': 'Session no longer exists',
  'worktree.list.noOwner': 'No session',
  'worktree.list.from': 'from {base}',
  'worktree.state.ready': 'In use',
  'worktree.state.kept': 'Kept',
  'worktree.state.creating': 'Creating',
  'worktree.state.removed': 'Removed',
  'worktree.state.removedSnapshot': 'Removed, changes in a snapshot',
  'worktree.remove': 'Remove',
  'worktree.remove.ask':
    'Removes the worktree folder and keeps the branch. Uncommitted changes can be saved as a snapshot and restored later.',
  'worktree.remove.keep': 'Save snapshot and remove',
  'worktree.remove.discard': 'Discard changes and remove',
  'worktree.removeBranch': 'Remove with branch',
  'worktree.removeBranch.ask':
    'Removes the worktree folder, the branch {branch} and its snapshot. Unmerged commits on the branch are lost for good.',
  'diffs.since': 'Since {commit}',
  'diffs.since.tip':
    'This session is in a worktree: All compares against where the worktree started (its latest common commit with the base branch), so committed changes are included',
  'worktree.sync': 'Merge {base}',
  'worktree.syncing': 'Merging…',
  'worktree.sync.hint':
    'Merge new commits from the base branch into this worktree (nothing is pushed). Commit the worktree’s changes first',
  'worktree.sync.merged': 'Merged the new commits from {base}.',
  'worktree.sync.upToDate': '{base} has no new commits.',
  'worktree.sync.conflicts':
    'The merge has conflicts and is stopped there: {files}. Resolve them in the terminal or ask the model to.',
  'worktree.check': 'New worktree',
  'worktree.check.hint':
    'Checked: the sub-session gets its own worktree and branch. Unchecked: it shares this session’s folder',
}
