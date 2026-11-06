// 本机整理（本机分组、全局置顶的先后）存在用户数据目录的 sidebar-organizer.json 里，核心是唯一的写入者。
// 写的时候先把现在这份有效的留成 .bak，再写临时文件、改名换上；断电也不会留下半个文件。
// 读的时候：主文件坏了而备份有效，把坏的挪到一边（保留原件）再用备份；没有可用的备份就报坏、停用写入。
// 版本更高的文件一律不碰。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type OrganizerLoad, type OrganizerStore, parseOrganizer } from '@litch/core'

export const ORGANIZER_FILE = 'sidebar-organizer.json'

function readLoad(path: string): OrganizerLoad | null {
  if (!existsSync(path)) return null
  try {
    return parseOrganizer(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { kind: 'corrupt' }
  }
}

export function fileOrganizerStore(dir: string, now: () => number = Date.now): OrganizerStore {
  const main = join(dir, ORGANIZER_FILE)
  const backup = `${main}.bak`
  return {
    load() {
      const primary = readLoad(main)
      if (primary?.kind === 'ok' || primary?.kind === 'newer') return primary
      const spare = readLoad(backup)
      if (spare?.kind !== 'ok') return primary ?? { kind: 'empty' }
      // 主文件坏了或没了、备份有效：坏的原件挪到一边留着，再用备份
      if (primary) renameSync(main, join(dir, `sidebar-organizer.corrupt-${now()}.json`))
      return spare
    },
    save(file) {
      if (readLoad(main)?.kind === 'ok') writeFileSync(backup, readFileSync(main))
      const temp = `${main}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
      renameSync(temp, main)
    },
  }
}
