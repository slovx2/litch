// “关于”那一页要外壳给的东西：应用里带着哪些许可文本，以及其中一份的全文。
// 装好的应用里它们在 Contents/Resources/licenses（scripts/licenses.mjs 在打包时收的，目录里有一份清单 index.json）；
// 没打包的时候逐包的文本没有收，只有仓库根目录里本项目自己的 LICENSE 和 THIRD_PARTY_NOTICES.md。
// 页面只能按清单里的标识来取，不能给路径：读哪个文件由这里定。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LicenseEntry {
  /** 取全文时用的标识：本项目的两份是 project、notices，第三方的是清单里的文件名 */
  id: string
  name: string
  version: string
  license: string
}

export interface LicenseShelf {
  project: LicenseEntry | null
  notices: LicenseEntry | null
  /** null：这一份应用里没有带逐包的许可文本 */
  packages: LicenseEntry[] | null
}

export interface Licenses {
  shelf: LicenseShelf
  /** 一份的全文。清单里没有的标识是 null */
  text(id: string): string | null
}

const PROJECT_FILE = 'LICENSE'
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** 读打包时写的清单。没有、读不懂都是 null */
function readIndex(dir: string): (LicenseEntry & { path: string })[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const entries: (LicenseEntry & { path: string })[] = []
  for (const item of parsed as Record<string, unknown>[]) {
    const file = text(item?.file)
    // 清单里的文件名只能是这个目录里的一个文件，不许带路径
    if (!file || file.includes('/') || file.includes('\\') || file.startsWith('.')) continue
    entries.push({
      id: file,
      name: text(item.name),
      version: text(item.version),
      license: text(item.license),
      path: join(dir, file),
    })
  }
  return entries
}

/**
 * bundled：应用里带着的许可目录（没有就是 null）；source：仓库的根目录（只在没打包时给）。
 * 本项目自己的两份先在 bundled 里找，没有再到 source 里找
 */
export function openLicenses(
  appName: string,
  bundled: string | null,
  source: string | null,
): Licenses {
  const paths = new Map<string, string>()
  const own = (id: string, file: string, name: string, license: (body: string) => string) => {
    for (const dir of [bundled, source]) {
      if (!dir || !existsSync(join(dir, file))) continue
      const path = join(dir, file)
      paths.set(id, path)
      let body = ''
      try {
        body = readFileSync(path, 'utf8')
      } catch {
        // 读不了就没有这一份
        paths.delete(id)
        return null
      }
      return { id, name, version: '', license: license(body) }
    }
    return null
  }
  // 许可证文件的头一行就是它的名字（“MIT License”）
  const firstLine = (body: string) =>
    body
      .split('\n')
      .find((line) => line.trim())
      ?.trim() ?? ''
  const project = own('project', PROJECT_FILE, appName, firstLine)
  const notices = own('notices', NOTICES_FILE, NOTICES_FILE, () => '')
  const index = bundled ? readIndex(bundled) : null
  for (const entry of index ?? []) paths.set(entry.id, entry.path)
  return {
    shelf: {
      project,
      notices,
      packages:
        index?.map(({ id, name, version, license }) => ({ id, name, version, license })) ?? null,
    },
    text(id) {
      const path = paths.get(id)
      if (!path) return null
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
  }
}
