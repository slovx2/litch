// 对一个文件（或者目录）能做的几件事：加入对话、复制路径。树上的右键菜单和查看器的标题栏用的是同一份。

import { showToast } from '../app/toasts.tsx'
import { mentionInComposer } from '../composer/drafts.ts'
import { saveToLocal } from './save.ts'

export type FileAction = 'mention' | 'copyRelative' | 'copyFull' | 'saveLocal' | 'revealLocal'

export const FILE_ACTIONS: readonly FileAction[] = ['mention', 'copyRelative', 'copyFull']

export interface FileSubject {
  deviceId?: string
  root?: string
  /** 完整路径 */
  path: string
  /** 相对于工作区根的路径 */
  relative: string
  /** 是目录：加入对话时路径后面带一个斜杠，看得出是目录 */
  dir?: boolean
  line?: number | null
}

function copy(text: string): void {
  navigator.clipboard.writeText(text).then(
    () => showToast({ id: 'files-copied', lifeMs: 2500, text: (t) => t('files.copied', { text }) }),
    () =>
      showToast({
        id: 'files-copied',
        tone: 'err',
        lifeMs: 5000,
        text: (t) => t('files.copyFailed'),
      }),
  )
}

export function runFileAction(action: FileAction, subject: FileSubject, host?: HTMLElement): void {
  if (action === 'revealLocal') {
    if (subject.deviceId && subject.root) {
      const source = { deviceId: subject.deviceId, root: subject.root, path: subject.path }
      void window.litchShell
        ?.revealFile?.(source)
        .then((result) => {
          if (result !== 'opened')
            showToast({
              id: 'files-reveal',
              host,
              tone: 'err',
              lifeMs: 5000,
              text: (t) => t(`files.reveal.${result}`),
            })
        })
        .catch(() =>
          showToast({
            id: 'files-reveal',
            host,
            tone: 'err',
            lifeMs: 5000,
            text: (t) => t('files.reveal.failed'),
          }),
        )
    }
    return
  }
  if (action === 'saveLocal') {
    if (!subject.dir && subject.deviceId && subject.root)
      saveToLocal({ deviceId: subject.deviceId, root: subject.root, path: subject.path })
    return
  }
  if (action === 'copyRelative') {
    copy(subject.relative || subject.path)
    return
  }
  if (action === 'copyFull') {
    copy(subject.path)
    return
  }
  const path = subject.dir ? `${subject.relative}/` : subject.relative
  // 输入区现在不在（正停在审批、提问上，或者开着别的页面）：说一声，不悄悄丢掉
  const mention = {
    kind: 'file' as const,
    path,
    full: subject.path,
    dir: subject.dir === true,
    line: subject.line ?? null,
  }
  if (!mentionInComposer(mention)) {
    showToast({ id: 'files-mention', lifeMs: 4000, text: (t) => t('files.mention.none') })
  }
}
