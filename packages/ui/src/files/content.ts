// 读一个文件的内容。读过的留一小会儿：在几个开着的文件之间来回切，先照上次读到的显示，同时重新去读一遍
// ——文件是对面的引擎随时在改的，留着的那一份只用来垫一下，不当真。
import type { ChannelErrorShape, FileContent } from '@litch/core'
import { useEffect, useState } from 'react'
import { useServices } from '../app/services.tsx'

export type Loaded =
  /** content：上次读到的那一份（有就先照着显示） */
  | { state: 'loading'; content: FileContent | null }
  | { state: 'ready'; content: FileContent }
  | { state: 'failed'; error: ChannelErrorShape; content: null }

const kept = new Map<string, FileContent>()
/** 最多留这么多个文件的内容，多了从最早的丢 */
const KEEP = 12

function keep(id: string, content: FileContent): void {
  kept.delete(id)
  kept.set(id, content)
  while (kept.size > KEEP) {
    const oldest = kept.keys().next().value
    if (oldest === undefined) break
    kept.delete(oldest)
  }
}

/** 两次读到的是不是一样的。一样就接着用原来那一份：界面不用重画，上好的颜色也不用重上 */
function sameContent(a: FileContent, b: FileContent): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text && a.lossy === b.lossy
  if (a.kind === 'tooLarge' && b.kind === 'tooLarge') return a.bytes === b.bytes
  if (a.kind === 'binary' && b.kind === 'binary') return a.bytes === b.bytes && a.group === b.group
  return true
}

/** nonce：变一次就不管留着的、重新读一次（“刷新”） */
export function useFileContent(
  deviceId: string,
  root: string,
  path: string,
  nonce: number,
): Loaded {
  const { channel } = useServices()
  const id = `${deviceId}\n${path}`
  const [loaded, setLoaded] = useState<Loaded>(() => ({
    state: 'loading',
    content: kept.get(id) ?? null,
  }))

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 变了就是要重新读
  useEffect(() => {
    const before = kept.get(id) ?? null
    setLoaded({ state: 'loading', content: before })
    const abort = new AbortController()
    channel.command('files.read', { deviceId, root, path }, { signal: abort.signal }).then(
      (content) => {
        if (abort.signal.aborted) return
        const next = before && sameContent(before, content) ? before : content
        keep(id, next)
        setLoaded({ state: 'ready', content: next })
      },
      (error: ChannelErrorShape) => {
        if (abort.signal.aborted || error.code === 'cancelled') return
        kept.delete(id)
        setLoaded({ state: 'failed', error, content: null })
      },
    )
    return () => abort.abort()
  }, [channel, deviceId, root, path, id, nonce])

  return loaded
}
