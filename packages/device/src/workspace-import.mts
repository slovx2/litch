// 设备级的工作区第一次启用时，从各引擎现有的项目导入（设计文档 03 第 6.1 节）。
// 这个文件是“读”和“并”两步，什么时候做在 importer.mts。
//
// 读：只用引擎现成的协议方法（project/list、threadSection/list、thread/list），只读不写。
// 会话的归属、分区、置顶不按项目一个个去查，而是把会话列一遍（没归档的和归档了的），从会话对象上读。
//
// 并（规则，同样的输入得到同样的结果）：
// - 根目录集合相同的项目合成一个工作区（不管来自几个引擎）。名称、根目录、标识取其中最早创建的那个，
//   各个来源（哪个 harness、原来的标识、原来的名称）记在元数据的 litch.import.sources 里备查。
//   一个根目录都没有的项目不和谁合；名称相同但根目录不同的不合，各自保留。
// - 设备上已经有根目录集合相同的工作区（之前导入的，或者用户在聚合面上建的）时并进它，不改它的名称和根目录。
// - 新工作区按“harness 的顺序、它在那个引擎里的顺序”排在现有的后面。
// - 自定义分区按名称合；置顶是固定的那一个分区。
// - 会话的归属、分区只补不盖：会话在设备层已经有的不动。
import type { DatabaseSync } from 'node:sqlite'
import type { Project } from '../../shared/src/project-store.mjs'
import { PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import { nowSeconds } from '../../shared/src/util.mjs'
import type { SideLink } from './side-link.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { isObject, UpstreamRpcError } from './wire.mjs'
import type { Workspaces } from './workspaces.mjs'

/** 元数据里记来源的键。值是 JSON：[{harness, projectId, name}] */
export const IMPORT_SOURCES_KEY = 'litch.import.sources'

export interface SourceProject {
  id: string
  name: string
  roots: { path: string }[]
  metadata: Record<string, string>
  position: number
  createdAt: number
  updatedAt: number
}

export interface SourceSection {
  id: string
  name: string
  appearance: unknown
}

export interface SourceThread {
  id: string
  updatedAt: number
  archived: boolean
  projectId: string | null
  sectionId: string | null
  sectionEnteredAt: number | null
}

/** 从一个引擎读到的东西 */
export interface HarnessSnapshot {
  harness: string
  projects: SourceProject[]
  sections: SourceSection[]
  threads: SourceThread[]
}

const PAGE = 200
const MAX_PAGES = 500

const number = (value: unknown): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.floor(parsed) : 0
}

/** 把一个翻页的列表方法取完 */
async function drain(
  link: SideLink,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown[]> {
  const all: unknown[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await link.call(method, {
      ...params,
      limit: PAGE,
      ...(cursor ? { cursor } : {}),
    })
    if (!isObject(result) || !Array.isArray(result.data))
      throw new Error(`${method} 的应答形状不对`)
    all.push(...result.data)
    const next = typeof result.nextCursor === 'string' ? result.nextCursor : null
    if (next === null || next === cursor || result.data.length === 0) return all
    cursor = next
  }
  throw new Error(`${method} 翻了 ${MAX_PAGES} 页还没有到头`)
}

/** 引擎明确回了错误（不认识这个方法、这部分功能是坏的）：当它没有这部分数据。别的错误照抛 */
async function optional(
  link: SideLink,
  method: string,
  note: (line: string) => void,
): Promise<unknown[]> {
  try {
    return await drain(link, method, {})
  } catch (error) {
    if (!(error instanceof UpstreamRpcError)) throw error
    note(`${method} 回了错误（${error.message}），当作没有`)
    return []
  }
}

function sourceProject(value: unknown): SourceProject | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.name !== 'string')
    return null
  const roots = Array.isArray(value.roots) ? value.roots : []
  return {
    id: value.id,
    name: value.name,
    roots: roots.flatMap((root) =>
      isObject(root) && typeof root.path === 'string' ? [{ path: root.path }] : [],
    ),
    metadata: Object.fromEntries(
      Object.entries(isObject(value.metadata) ? value.metadata : {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    position: number(value.position),
    createdAt: number(value.createdAt),
    updatedAt: number(value.updatedAt),
  }
}

function sourceThread(value: unknown, archived: boolean): SourceThread | null {
  if (!isObject(value) || typeof value.id !== 'string') return null
  const section = isObject(value.section) ? value.section.id : null
  return {
    id: value.id,
    updatedAt: number(value.updatedAt),
    archived,
    projectId: typeof value.projectId === 'string' && value.projectId ? value.projectId : null,
    // 早先的数据可能只有置顶的标记、没有分区
    sectionId:
      typeof section === 'string' ? section : value.isPinned === true ? PINNED_SECTION_ID : null,
    sectionEnteredAt: typeof value.sectionEnteredAt === 'number' ? value.sectionEnteredAt : null,
  }
}

export async function readHarness(
  harness: string,
  link: SideLink,
  log: (line: string) => void,
): Promise<HarnessSnapshot> {
  const note = (line: string) => log(`导入 ${harness}：${line}`)
  const projects = (await optional(link, 'project/list', note)).flatMap((value) => {
    const project = sourceProject(value)
    return project ? [project] : []
  })
  const sections = (await optional(link, 'threadSection/list', note)).flatMap((value) =>
    isObject(value) && typeof value.id === 'string' && typeof value.name === 'string'
      ? [{ id: value.id, name: value.name, appearance: value.appearance }]
      : [],
  )
  const threads: SourceThread[] = []
  // 归档了的会话也带着归属：恢复之后它应该回到原来的工作区里
  for (const archived of [false, true])
    for (const value of await drain(link, 'thread/list', archived ? { archived: true } : {})) {
      const thread = sourceThread(value, archived)
      if (thread) threads.push(thread)
    }
  return { harness, projects, sections, threads }
}

/** 根目录集合的比较键。一个根目录都没有的不和谁比 */
function rootsKey(roots: { path: string }[]): string | null {
  const paths = roots.map((root) => root.path.replace(/(?<=.)[\\/]+$/, ''))
  return paths.length ? JSON.stringify([...new Set(paths)].sort()) : null
}

interface Member {
  harness: string
  project: SourceProject
}

interface Group {
  /** 并进哪个工作区。null：还没有，要新建 */
  target: string | null
  members: Member[]
}

function sourcesOf(metadata: Record<string, string>): unknown[] {
  try {
    const parsed: unknown = JSON.parse(metadata[IMPORT_SOURCES_KEY] ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 先来的说了算：按给的顺序，前面已经有的键不被后面的盖掉 */
function firstWins(all: Record<string, string>[]): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const metadata of all)
    for (const [key, value] of Object.entries(metadata)) if (!(key in merged)) merged[key] = value
  return merged
}

export interface ImportCounts {
  created: number
  merged: number
  sections: number
  assigned: number
  placed: number
}

function mergeProjects(
  workspaces: Workspaces,
  snapshots: HarnessSnapshot[],
  counts: ImportCounts,
): Map<string, Group> {
  const existing = workspaces.projects.list()
  const taken = new Set(existing.map((project) => project.id))
  const targetByRoots = new Map<string, string>()
  for (const project of existing) {
    const key = rootsKey(project.roots)
    if (key !== null && !targetByRoots.has(key)) targetByRoots.set(key, project.id)
  }
  const groups: Group[] = []
  const groupByRoots = new Map<string, Group>()
  /** 键是“harness 换行 引擎里的项目标识” */
  const groupOf = new Map<string, Group>()
  for (const snapshot of snapshots) {
    const ordered = [...snapshot.projects].sort(
      (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
    )
    for (const project of ordered) {
      const key = rootsKey(project.roots)
      let group = key === null ? undefined : groupByRoots.get(key)
      if (!group) {
        group = { target: (key === null ? undefined : targetByRoots.get(key)) ?? null, members: [] }
        groups.push(group)
        if (key !== null) groupByRoots.set(key, group)
      }
      group.members.push({ harness: snapshot.harness, project })
      groupOf.set(`${snapshot.harness}\n${project.id}`, group)
    }
  }
  for (const group of groups) {
    // 最早创建的排最前；同一秒的保持原来的先后（harness 的顺序、引擎里的顺序）
    const byAge = [...group.members].sort((a, b) => a.project.createdAt - b.project.createdAt)
    const eldest = byAge[0]
    if (!eldest) continue
    const sources = group.members.map(({ harness, project }) => ({
      harness,
      projectId: project.id,
      name: project.name,
    }))
    const updatedAt = Math.max(...group.members.map((member) => member.project.updatedAt))
    // 标识撞上了已有的工作区（同一份数据导了两遍）：当作同一个
    if (group.target === null && taken.has(eldest.project.id)) group.target = eldest.project.id
    if (group.target === null) {
      workspaces.adopt({
        id: eldest.project.id,
        name: eldest.project.name,
        roots: eldest.project.roots,
        metadata: {
          ...firstWins(byAge.map((member) => member.project.metadata)),
          [IMPORT_SOURCES_KEY]: JSON.stringify(sources),
        },
        createdAt: eldest.project.createdAt,
        updatedAt,
      })
      group.target = eldest.project.id
      taken.add(group.target)
      counts.created++
    } else {
      const project: Project = workspaces.projects.read(group.target)
      const metadata = firstWins([
        project.metadata,
        ...byAge.map((member) => member.project.metadata),
      ])
      metadata[IMPORT_SOURCES_KEY] = JSON.stringify([...sourcesOf(project.metadata), ...sources])
      workspaces.absorb(project, metadata, updatedAt)
      counts.merged++
    }
  }
  return groupOf
}

function mergeSections(
  workspaces: Workspaces,
  snapshots: HarnessSnapshot[],
  now: number,
  counts: ImportCounts,
): Map<string, string> {
  const byName = new Map<string, string>()
  for (const section of workspaces.sections.list())
    if (section.id !== PINNED_SECTION_ID) byName.set(section.name, section.id)
  /** 键是“harness 换行 引擎里的分区标识”，值是设备层的分区标识 */
  const sectionOf = new Map<string, string>()
  for (const snapshot of snapshots) {
    sectionOf.set(`${snapshot.harness}\n${PINNED_SECTION_ID}`, PINNED_SECTION_ID)
    for (const section of snapshot.sections) {
      const name = section.name.trim()
      if (section.id === PINNED_SECTION_ID || !name) continue
      let target = byName.get(name)
      if (target === undefined) {
        target = section.id
        if (!workspaces.sections.get(target)) {
          workspaces.adoptSection(target, name, section.appearance, now)
          counts.sections++
        }
        byName.set(name, target)
      }
      sectionOf.set(`${snapshot.harness}\n${section.id}`, target)
    }
  }
  return sectionOf
}

/**
 * 把读到的东西并进设备库，整个在一个事务里：要么都进去并记下“这几个 harness 导入过了”，要么都没有。
 * snapshots 的顺序就是 harness 的顺序。
 */
export function mergeSnapshots(
  db: DatabaseSync,
  index: ThreadIndex,
  workspaces: Workspaces,
  snapshots: HarnessSnapshot[],
  now = nowSeconds(),
): ImportCounts {
  const counts: ImportCounts = { created: 0, merged: 0, sections: 0, assigned: 0, placed: 0 }
  const merge = (): void => {
    const groupOf = mergeProjects(workspaces, snapshots, counts)
    const sectionOf = mergeSections(workspaces, snapshots, now, counts)
    for (const snapshot of snapshots)
      for (const thread of snapshot.threads) {
        index.see({ id: thread.id, updatedAt: thread.updatedAt }, snapshot.harness, thread.archived)
        const group = thread.projectId
          ? groupOf.get(`${snapshot.harness}\n${thread.projectId}`)
          : undefined
        if (group?.target && workspaces.link(thread.id, group.target)) counts.assigned++
        const section = thread.sectionId
          ? sectionOf.get(`${snapshot.harness}\n${thread.sectionId}`)
          : undefined
        if (
          section &&
          workspaces.settle(thread.id, section, thread.sectionEnteredAt ?? thread.updatedAt)
        )
          counts.placed++
      }
    const mark = db.prepare(
      'INSERT OR REPLACE INTO imports(harness, imported_at, summary) VALUES(?,?,?)',
    )
    for (const snapshot of snapshots)
      mark.run(
        snapshot.harness,
        now,
        JSON.stringify({ projects: snapshot.projects.length, threads: snapshot.threads.length }),
      )
  }
  try {
    // 事务成了，这期间该发的通知才发出去
    workspaces.atomically(merge)
  } catch (error) {
    // 事务里登记过的会话没有落库，内存里的那一份不能留着
    index.reset()
    throw error
  }
  return counts
}
