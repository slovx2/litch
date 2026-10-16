// 输入框里打 `@` 找文件：问设备上的模糊搜索（核心的 files.search，和文件面板的找文件是同一条命令、同一个防抖），
// 把结果变成单子上的条目。找的是会话的工作目录，结果里的路径相对于它——harness 也是从这个目录认路径的。
// 行上只放名字和它所在的目录；完整的位置在单子底下那一栏。
import type { FileMatch, MessageExtra } from '@litch/core'
import { useT } from '../app/appearance.ts'
import { whyNot } from '../app/errors.ts'
import { useFileSearch } from '../files/FileSearch.tsx'
import type { SuggestEntry, SuggestGroup } from './Suggest.tsx'

export interface FileHitsHost {
  deviceId: string
  /** 在哪个目录里找：会话的工作目录。没有（不属于工作区的新对话）就找不了 */
  root: string | null
  /** 设备连着没有 */
  online: boolean
  /** 这是在新建对话页上：没有目录的时候说的是“先选一个工作区” */
  fresh: boolean
}

export interface FileHits {
  group: SuggestGroup
  /** 单子上的一项对应的、要随消息带上的那个文件。不是这里的条目就是 null */
  extraOf(entryId: string): MessageExtra | null
}

/** 目录的路径后面带一个斜杠，看得出是目录（文件面板的“加入对话”也是这个写法） */
const spelled = (match: FileMatch): string =>
  match.kind === 'dir' ? `${match.relative.replace(/\/+$/, '')}/` : match.relative

const idOf = (match: FileMatch): string => `file:${spelled(match)}`

/** query 是 `@` 后面打的字；null 是单子没开（这时什么都不问） */
export function useFileHits(host: FileHitsHost, query: string | null): FileHits {
  const t = useT()
  const { root, online } = host
  const able = query !== null && root !== null && online
  const search = useFileSearch(host.deviceId, root ?? '', able ? query : '')

  const entries: SuggestEntry[] = search.matches.map((match) => {
    const path = spelled(match)
    const cut = match.relative.replace(/\/+$/, '').lastIndexOf('/')
    return {
      id: idOf(match),
      kind: match.kind,
      title: path.slice(cut + 1),
      // 所在的目录；就在根下面的不写
      note: cut < 0 ? '' : path.slice(0, cut + 1),
      facts: [{ label: t('at.path'), value: match.path }],
      words: [],
    }
  })

  let status: SuggestGroup['status']
  if (root === null) status = { text: t(host.fresh ? 'at.noRoot.fresh' : 'at.noRoot') }
  else if (!online) status = { text: t('at.offline') }
  else if (!query?.trim()) status = { text: t('at.hint') }
  else if (search.status === 'failed') {
    // 对面没有找文件这回事：不是出错，照实说；别的才是没找成
    status =
      search.error?.code === 'unsupported'
        ? { text: t('at.unsupported') }
        : { text: t('at.failed', { reason: whyNot(search.error, t) }), tone: 'err' }
  } else if (entries.length === 0) {
    status = { text: t(search.status === 'ready' ? 'at.none' : 'at.searching') }
  }

  return {
    group: { id: 'files', title: t('at.group'), entries, ...(status ? { status } : {}) },
    extraOf(entryId) {
      const match = search.matches.find((entry) => idOf(entry) === entryId)
      if (!match) return null
      const path = spelled(match)
      const cut = match.relative.replace(/\/+$/, '').lastIndexOf('/')
      return { kind: 'file', name: path.slice(cut + 1), path }
    },
  }
}
