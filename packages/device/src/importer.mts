// 什么时候从各引擎导入现有的项目（怎么读、怎么并在 workspace-import.mts）。
//
// 每个 harness 各自记“导入过没有”（设备库的 imports 表），一个 harness 只导入一次：
// 之后两边各管各的，引擎那边再建的项目不会跟过来，
// 用户在聚合面上删掉、改掉的东西也不会被再导回来。删掉设备库就是从头再导一遍。
//
// 引擎当时不可用（没起来、连不上、读到一半断了）就不记，它下一次可用的时候补导入：
// 它的项目按同样的规则并进已有的工作区，没有根目录相同的才新建、排在后面。
// “可用的时候”有三个时机：设备进程启动、适配器主进程说它起来了、某条聚合面连接连上了它；
// 另外每次有客户端握手也会看一遍。
import type { DatabaseSync } from 'node:sqlite'
import type { HarnessSource } from './session.mjs'
import { openSideLink, type SideLink } from './side-link.mjs'
import type { ThreadIndex } from './thread-index.mjs'
import { type HarnessSnapshot, mergeSnapshots, readHarness } from './workspace-import.mjs'
import type { Workspaces } from './workspaces.mjs'

export interface ImporterOptions {
  db: DatabaseSync
  index: ThreadIndex
  workspaces: Workspaces
  /** 这台设备上现在已知的全部 harness，顺序就是合并时的顺序 */
  harnesses(): HarnessSource[]
  /** 握手时报给引擎的设备服务版本 */
  version: string
  /** 向引擎问一个问题最多等多久 */
  timeoutMs: number
  log(line: string): void
}

const text = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class WorkspaceImporter {
  private readonly options: ImporterOptions
  private readonly done = new Set<string>()
  private readonly links = new Set<SideLink>()
  /** 每个 harness 上一次没导入成的原因 */
  private readonly failures = new Map<string, string>()
  private running: Promise<void> | null = null
  /** 这一轮进行的时候又有人来催过：结束后再看一遍 */
  private again = false
  private closed = false

  constructor(options: ImporterOptions) {
    this.options = options
    options.db.exec(`CREATE TABLE IF NOT EXISTS imports(
      harness TEXT PRIMARY KEY, imported_at INTEGER NOT NULL, summary TEXT NOT NULL
    ) WITHOUT ROWID`)
    for (const row of options.db.prepare('SELECT harness FROM imports').all())
      this.done.add(String(row.harness))
  }

  /** 看一遍名单：没导入过、现在该连得上的 harness 导入一次。已经在导入就等这一轮完了再看 */
  kick(): void {
    if (this.closed) return
    if (this.running) {
      this.again = true
      return
    }
    const pending = this.options
      .harnesses()
      // 适配器主进程说它没在跑的不用去连
      .filter((source) => !source.managed || source.managed.state === 'running')
      .filter((source) => !this.done.has(source.id))
    if (pending.length === 0) return
    this.running = this.round(pending)
      .catch((error) => this.options.log(`导入现有的项目时出错：${text(error)}`))
      .finally(() => {
        this.running = null
        if (!this.again) return
        this.again = false
        this.kick()
      })
  }

  /** 正在进行的那一轮结束。没有在导入就是已经结束了 */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  private async round(pending: HarnessSource[]): Promise<void> {
    // 几个引擎一起读，读完按名单的顺序一次并进去：谁先读完不影响结果
    const read = await Promise.all(pending.map((source) => this.read(source)))
    const snapshots = read.filter((snapshot): snapshot is HarnessSnapshot => snapshot !== null)
    if (this.closed || snapshots.length === 0) return
    const { db, index, workspaces, log } = this.options
    const counts = mergeSnapshots(db, index, workspaces, snapshots)
    for (const snapshot of snapshots) this.done.add(snapshot.harness)
    log(
      `从 ${snapshots.map((snapshot) => snapshot.harness).join('、')} 导入了现有的项目：` +
        `新建 ${counts.created} 个工作区，并进已有的 ${counts.merged} 个，分区 ${counts.sections} 个，` +
        `会话归属 ${counts.assigned} 条，分区与置顶 ${counts.placed} 条`,
    )
  }

  private async read(source: HarnessSource): Promise<HarnessSnapshot | null> {
    const { version, timeoutMs, log } = this.options
    let link: SideLink | null = null
    try {
      link = await openSideLink(source.connect, version, timeoutMs)
      if (this.closed) return null
      this.links.add(link)
      return await readHarness(source.id, link, log)
    } catch (error) {
      // 每次有客户端握手都会再试一遍：原因没变的不重复写日志
      const reason = text(error)
      if (this.failures.get(source.id) !== reason) {
        this.failures.set(source.id, reason)
        log(`${source.id} 现有的项目这一次没有导入成，它可用的时候再试：${reason}`)
      }
      return null
    } finally {
      if (link) {
        this.links.delete(link)
        link.close()
      }
    }
  }

  /** 设备进程要关了：正在读的断掉，等这一轮收场 */
  async close(): Promise<void> {
    this.closed = true
    for (const link of this.links) link.close()
    await this.running
  }
}
