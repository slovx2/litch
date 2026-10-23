// 工作树在界面上的几句通用说法：起点怎么念。
import type { Translator } from '../i18n/index.ts'

/** 起点：分支名照写；HEAD、当前本地状态换成话 */
export function baseName(baseRef: string, t: Translator): string {
  if (baseRef === 'working-tree') return t('worktree.base.working')
  if (baseRef === 'HEAD' || baseRef === '') return t('worktree.base.head')
  return baseRef
}
