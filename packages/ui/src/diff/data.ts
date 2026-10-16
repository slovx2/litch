// 差异的内容从哪来：接成一长条时一次取全部文件，一次看一个时只取选中的那个；概况每换一版就重新取。
// 取回来的和手上的一样的话还用手上那个对象：上好的色、展开的上下文都按对象记着，不白丢。
import type { ChannelErrorShape, DiffScope, FileDiff } from '@litch/core'
import { useEffect, useRef, useState } from 'react'
import { useServices } from '../app/services.tsx'

export interface Where {
  deviceId: string
  root: string
  scope: DiffScope
  sessionId: string | null
}

export interface Loaded {
  /** 取到的文件，按概况里的顺序。还没取到过是 null */
  files: readonly FileDiff[] | null
  state: 'loading' | 'ready' | 'failed'
  error: ChannelErrorShape | null
  /** 对面说太多了，不一次全给：改成一个一个看 */
  truncated: boolean
}

const EMPTY: Loaded = { files: null, state: 'loading', error: null, truncated: false }

const same = (a: FileDiff, b: FileDiff): boolean => JSON.stringify(a) === JSON.stringify(b)

/** 新取到的和手上的对一遍：没变的还用手上的对象 */
function settle(
  before: readonly FileDiff[] | null,
  next: readonly FileDiff[],
): readonly FileDiff[] {
  if (!before) return next
  const known = new Map(before.map((file) => [file.path, file]))
  return next.map((file) => {
    const old = known.get(file.path)
    return old && same(old, file) ? old : file
  })
}

/**
 * version 是概况的版本，变了就重新取。paths 是 null：一次取全部；给了路径：只取这一个。
 * enabled 为假时什么都不取（面板没开着、概况还没好）
 */
export function useDiffFiles(
  where: Where,
  version: number,
  path: string | null,
  all: boolean,
  enabled: boolean,
): Loaded {
  const { channel } = useServices()
  const [loaded, setLoaded] = useState<Loaded>(EMPTY)
  const kept = useRef<{ id: string; files: readonly FileDiff[] } | null>(null)
  const { deviceId, root, scope, sessionId } = where
  const id = `${deviceId}\n${root}\n${scope}\n${sessionId ?? ''}\n${all ? '*' : (path ?? '')}`

  // biome-ignore lint/correctness/useExhaustiveDependencies: version 变了就是要重新取
  useEffect(() => {
    if (!enabled || (!all && path === null)) {
      setLoaded(EMPTY)
      return
    }
    const before = kept.current?.id === id ? kept.current.files : null
    setLoaded((was) => ({ ...was, files: before, state: 'loading', error: null }))
    const abort = new AbortController()
    const params = { deviceId, root, scope, sessionId }
    const work: Promise<{ files: readonly FileDiff[]; truncated: boolean }> = all
      ? channel.command('diff.files', params, { signal: abort.signal })
      : channel
          .command('diff.file', { ...params, path: path ?? '' }, { signal: abort.signal })
          .then((file) => ({ files: [file], truncated: false }))
    work.then(
      (result) => {
        if (abort.signal.aborted) return
        const files = settle(before, result.files)
        kept.current = { id, files }
        setLoaded({ files, state: 'ready', error: null, truncated: result.truncated })
      },
      (error: ChannelErrorShape) => {
        if (abort.signal.aborted || error.code === 'cancelled') return
        setLoaded({ files: before, state: 'failed', error, truncated: false })
      },
    )
    return () => abort.abort()
  }, [channel, id, version, enabled])

  return loaded
}
