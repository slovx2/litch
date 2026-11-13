import { isAbsolutePath, normalizePath, parentPath, type UserAttachment } from '@litch/core'
import { useT } from '../../app/appearance.ts'
import type { AttachmentContext } from '../FileCard.tsx'
import { attachmentSource } from './actions.ts'
import { useMediaMenu } from './MediaMenu.tsx'
import { useInlineImage } from './use-inline-image.ts'

export function userImageSource(attachment: UserAttachment, deviceId?: string) {
  const path = attachment.path ? normalizePath(attachment.path) : ''
  const file =
    deviceId && isAbsolutePath(path) ? { deviceId, path, root: parentPath(path) ?? path } : null
  return attachmentSource(file, attachment.client === true)
}

export function UserImage({
  attachment,
  deviceId,
  open,
}: AttachmentContext & { attachment: UserAttachment; open(): void }) {
  const t = useT()
  const { image } = useInlineImage(attachment.url ?? '')
  const label = attachment.label ?? t('attachment.image')
  const media = useMediaMenu(
    { kind: 'image', source: userImageSource(attachment, deviceId), label, image },
    open,
  )
  return (
    <>
      <button
        type="button"
        className="uimg"
        title={label}
        aria-label={t('attachment.view')}
        onClick={(event) => {
          event.currentTarget.focus()
          open()
        }}
        onContextMenu={media.onContextMenu}
      >
        <img src={attachment.url} alt={label} />
      </button>
      {media.menu}
    </>
  )
}
