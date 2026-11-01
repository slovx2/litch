import { type CopyMessage, messageCopyText } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { Icon } from '../app/icons.tsx'
import { showToast } from '../app/toasts.tsx'

/** 复制只依赖这条消息，离线、回合进行中也可用；结果用现有提示条反馈。 */
export function MessageCopy({ item }: { item: CopyMessage }) {
  const t = useT()
  const copy = async () => {
    try {
      const text = messageCopyText(item, (attachment) => t(`attachment.${attachment.kind}`))
      if (!text) {
        showToast({
          id: 'message-copy',
          tone: 'plain',
          lifeMs: 4000,
          text: () => t('message.copy.empty'),
        })
        return
      }
      await navigator.clipboard.writeText(text)
      showToast({
        id: 'message-copy',
        tone: 'plain',
        lifeMs: 2000,
        text: () => t('message.copied'),
      })
    } catch {
      showToast({
        id: 'message-copy',
        tone: 'err',
        lifeMs: 8000,
        text: () => t('message.copy.failed'),
      })
    }
  }
  return (
    <button
      type="button"
      className="ibtn message-copy"
      title={t('message.copy')}
      aria-label={t('message.copy')}
      onClick={() => void copy()}
    >
      <Icon name="copy" small />
    </button>
  )
}
