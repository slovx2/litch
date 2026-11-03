import {
  type FileLinkResolution,
  keys,
  knownFileRef,
  type SessionSummary,
  sessionDestination,
} from '@litch/core'
import { useContext, useState } from 'react'
import type { ManagerView } from '../../../core/src/model-manager.mts'
import type { ManagerRelationTarget } from '../../../protocol/src/manager-posts.mts'
import { requestOpenSession } from '../app/actions.ts'
import { useT } from '../app/appearance.ts'
import { reasonOf } from '../app/errors.ts'
import { useServices } from '../app/services.tsx'
import { FileLinkDialog } from '../files/FileLinkDialog.tsx'
import { openInFiles } from '../files/state.ts'
import { ExternalLink } from '../transcript/ExternalLink.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'
import { BoardReferencesContext } from './BoardReferences.tsx'
import type { BoardReference } from './references.ts'

const icons = { issue: '○', item: '▤', thread: '↗', file: '▱', branch: '⑂', commit: '◇', url: '↗' }
export function RelationLink({
  target,
  manager,
  label,
  disabled = false,
}: {
  target: ManagerRelationTarget
  manager: ManagerView
  label?: string
  disabled?: boolean
}) {
  const t = useT()
  const { channel, replica } = useServices()
  const navigation = useContext(BoardReferencesContext)
  const [error, setError] = useState('')
  const [result, setResult] = useState<FileLinkResolution | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const content = (
    <>
      <span className="mg-relation-kind">
        <span aria-hidden="true">{icons[target.kind]}</span>{' '}
        {t(`manager.relationKind.${target.kind}`)}
      </span>{' '}
      {label ?? target.label ?? target.target}
    </>
  )
  const openFile = (resolution: FileLinkResolution, found = resolution.candidates[0]) => {
    if (!found) return
    const summary = replica.store.get<SessionSummary>(
      keys.summary(manager.deviceId, manager.threadId),
    )
    openInFiles({
      deviceId: manager.deviceId,
      workspaceId: summary?.workspaceId ?? null,
      ...found,
      link: resolution,
    })
  }
  const open = async () => {
    setError('')
    try {
      if (target.kind === 'issue' || target.kind === 'item') {
        if (
          !navigation ||
          (!navigation.deferred && !navigation.ids.has(target.target as BoardReference))
        )
          throw new Error(t('manager.linkUnavailable'))
        navigation.open(target.target as BoardReference)
      } else if (target.kind === 'thread') {
        if (sessionDestination(replica.store, manager.deviceId, target.target) === undefined)
          throw new Error(t('manager.linkUnavailable'))
        requestOpenSession({ deviceId: manager.deviceId, sessionId: target.target })
      } else if (target.kind === 'file') {
        const ref = knownFileRef(target.target, { root: manager.cwd, cwd: manager.cwd })
        if (!ref) throw new Error(t('manager.linkUnavailable'))
        const resolution = await channel.command('files.resolve', {
          deviceId: manager.deviceId,
          root: manager.cwd,
          ref,
          href: target.target,
        })
        if (resolution.status === 'ready' && resolution.candidates[0]) openFile(resolution)
        else setResult(resolution)
      } else if (target.kind === 'url') {
        throw new Error(t('manager.linkUnavailable'))
      } else {
        const response = await channel.command('managers.reference.read', {
          deviceId: manager.deviceId,
          managerId: manager.id,
          reference: target.target,
        })
        setPreview(response.text)
      }
    } catch (e) {
      setError(reasonOf(e, t))
    }
  }
  return (
    <>
      {target.kind === 'url' && /^https?:\/\//i.test(target.target) ? (
        <span data-relation-target={target.target}>
          <ExternalLink href={target.target}>{content}</ExternalLink>
        </span>
      ) : (
        <button
          type="button"
          className="btn ghost"
          title={disabled ? t('manager.oldDeviceShort') : target.target}
          disabled={disabled}
          data-relation-target={target.target}
          onClick={() => void open()}
        >
          {content}
        </button>
      )}
      {result ? (
        <FileLinkDialog
          result={result}
          onClose={() => setResult(null)}
          onPick={(found) => {
            openFile(result, found)
            setResult(null)
          }}
        />
      ) : null}
      {preview !== null ? (
        <dialog open className="mg-reference-preview">
          <button type="button" className="btn" onClick={() => setPreview(null)}>
            {t('manager.close')}
          </button>
          <BoardMarkdown text={`\`\`\`diff\n${preview}\n\`\`\``} />
        </dialog>
      ) : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
