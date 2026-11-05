import { type DeviceView, keys } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { useKey } from '../app/services.tsx'
import { FILE_ACTIONS, type FileAction, type FileSubject, runFileAction } from './actions.ts'
import { fileDestination, revealLabel } from './destination.ts'

export function useFileDestination(subject: FileSubject | null) {
  const device = useKey<DeviceView>(keys.device(subject?.deviceId ?? ''))
  if (!subject?.deviceId || !subject.root) return null
  return fileDestination(device?.kind, subject.dir === true, {
    reveal: !!window.litchShell?.revealFile,
    save: !!window.litchShell?.saveFile,
  })
}

export function useFileActions(subject: FileSubject | null): readonly FileAction[] {
  const destination = useFileDestination(subject)
  return destination ? [...FILE_ACTIONS, destination] : FILE_ACTIONS
}

export function fileActionLabel(action: FileAction) {
  return action === 'revealLocal'
    ? revealLabel(window.litchShell?.platform)
    : (`files.action.${action}` as const)
}

/** 源码、渲染预览和附件共用图标按钮与平台文案。 */
export function FileDestination({ subject }: { subject: FileSubject }) {
  const t = useT()
  const action = useFileDestination(subject)
  if (!action) return null
  const label = t(fileActionLabel(action))
  return (
    <button
      type="button"
      className="ibtn"
      data-tool={action === 'revealLocal' ? 'reveal-local' : 'save-local'}
      title={label}
      aria-label={label}
      onClick={() => runFileAction(action, subject)}
    >
      <Icon name={action === 'revealLocal' ? 'folderOpen' : 'download'} small />
    </button>
  )
}
