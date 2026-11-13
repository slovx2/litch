import { baseName, type FileSaveSource } from '@litch/core'
import { dismissToast, showToast } from '../app/toasts.tsx'
import { byteSize } from './lines.ts'

/** 只传设备路径；本机目标只由外壳的系统保存对话框决定。 */
export function saveToLocal(source: FileSaveSource, host?: HTMLElement): void {
  const shell = window.litchShell
  if (!shell?.saveFile || !shell.onFileSave || !shell.fileSaveAction) return
  const id = crypto.randomUUID()
  const name = baseName(source.path)
  const action = (kind: 'cancel' | 'open' | 'reveal') => {
    void shell.fileSaveAction?.(id, kind).catch((error) =>
      showToast({
        id,
        host,
        tone: 'err',
        lifeMs: 0,
        text: (t) => t('files.save.failed', { name, reason: String(error) }),
      }),
    )
  }
  const close = shell.onFileSave((progress) => {
    if (progress.id !== id) return
    if (progress.state === 'saving') {
      showToast({
        id,
        host,
        lifeMs: 0,
        text: (t) =>
          t('files.save.progress', {
            name,
            done: byteSize(progress.bytes),
            total: progress.total === null ? '…' : byteSize(progress.total),
          }),
        action: { label: (t) => t('files.save.cancel'), run: () => action('cancel') },
        onGone: () => action('cancel'),
      })
      return
    }
    close()
    if (progress.state === 'cancelled') {
      dismissToast(id)
      return
    }
    if (progress.state === 'failed') {
      showToast({
        id,
        host,
        tone: 'err',
        lifeMs: 0,
        text: (t) =>
          t('files.save.failed', {
            name,
            reason: progress.errorText ? t.text(progress.errorText) : (progress.error ?? ''),
          }),
      })
      return
    }
    showToast({
      id,
      host,
      lifeMs: 0,
      text: (t) => t('files.save.saved', { path: progress.destination }),
      action: { label: (t) => t('files.save.open'), run: () => action('open') },
      more: { label: (t) => t('files.save.reveal'), run: () => action('reveal') },
    })
  })
  showToast({ id, host, lifeMs: 0, text: (t) => t('files.save.choose', { name }) })
  void shell.saveFile({ ...source, id }).catch((error) => {
    close()
    showToast({
      id,
      host,
      tone: 'err',
      lifeMs: 0,
      text: (t) => t('files.save.failed', { name, reason: String(error) }),
    })
  })
}
