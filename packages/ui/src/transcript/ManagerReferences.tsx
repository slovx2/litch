// 对话正文只链接设备确认存在的编号；归属由会话上的经理标记决定。
import {
  keys,
  type ManagerView,
  managerMark,
  managerReferenceIds,
  managerReferencesResolver,
  type SessionSummary,
} from '@litch/core'
import {
  createContext,
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useKey, useServices } from '../app/services.tsx'
import { boardReferences } from '../manager/references.ts'

interface References {
  resolve(ids: string[]): Promise<Set<string>>
  open(id: string): void
}
export const TranscriptReferencesContext = createContext<References | null>(null)

export function ManagerReferencesScope({
  deviceId,
  sessionId,
  onOpen,
  children,
}: {
  deviceId: string
  sessionId: string
  onOpen?: ((selection: { deviceId: string; sessionId: string }) => void) | undefined
  children: ReactNode
}) {
  const { channel } = useServices()
  const summary = useKey<SessionSummary>(keys.summary(deviceId, sessionId))
  const managerId = summary ? managerMark(summary)?.managerId : undefined
  const manager = useKey<ManagerView>(keys.manager(deviceId, managerId ?? ''))
  const threadId = manager?.threadId
  const revision = manager?.updatedAt
  // biome-ignore lint/correctness/useExhaustiveDependencies: 看板版本变化时丢弃不存在编号的缓存
  const value = useMemo<References | null>(
    () =>
      managerId && threadId && onOpen
        ? {
            resolve: managerReferencesResolver(
              async (ids) =>
                (await channel.command('managers.references.resolve', { deviceId, managerId, ids }))
                  .ids,
            ),
            open: (id) => {
              onOpen({ deviceId, sessionId: threadId })
              setTimeout(
                () =>
                  window.dispatchEvent(
                    new CustomEvent('litch-manager-issue', { detail: { managerId, id } }),
                  ),
                0,
              )
            },
          }
        : null,
    [channel, deviceId, managerId, threadId, onOpen, revision],
  )
  return (
    <TranscriptReferencesContext.Provider value={value}>
      {children}
    </TranscriptReferencesContext.Provider>
  )
}

export function TranscriptReferences({
  text,
  plain,
}: {
  text: string
  plain(text: string): ReactNode
}) {
  const context = useContext(TranscriptReferencesContext)
  const [checked, setChecked] = useState<{ context: References; ids: Set<string> } | null>(null)
  useEffect(() => {
    if (!context) return
    const ids = managerReferenceIds(text)
    if (!ids.length) return
    let live = true
    void context.resolve(ids).then((ids) => {
      if (live) setChecked({ context, ids })
    })
    return () => {
      live = false
    }
  }, [context, text])
  if (!context || checked?.context !== context) return plain(text)
  return boardReferences(
    text,
    checked.ids as ReadonlySet<import('../manager/references.ts').BoardReference>,
    false,
    true,
  ).map((part, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 正文按 token 位置渲染
    <Fragment key={index}>
      {part.id ? (
        <button
          type="button"
          className="mg-decision-link"
          data-board-reference={part.id}
          onClick={() => context.open(part.id as string)}
        >
          {part.text}
        </button>
      ) : (
        plain(part.text)
      )}
    </Fragment>
  ))
}
