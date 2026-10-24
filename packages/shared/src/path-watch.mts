import { existsSync, type FSWatcher, statSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { debugLog } from './util.mjs'

const changeDebounceMs = 200
// 一次事件里监视最多挪几回。正常只会挪到路径的层数那么多回，这个数远在它之上。
const maxMovesPerEvent = 256
// 新建的监视过这么久再看一遍该监视哪里、目标在不在。macOS 上目录监视走 FSEvents，刚建好的那一小段
// 系统还没开始送事件，这段里的变化就没有事件（不是晚到，是丢了，机器越忙这段越长）：路径在这段里往前长了、
// 目标在这段里出现了，不再看一遍的话监视就停在上一层，要等那个目录下一次有变化才跟上。
const armRecheckMs = 250

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// 与 Codex 0.157.1 的 fs/watch 相同：只做非递归监视；目标不存在时监视最近的已存在
// 祖先目录，路径出现后再移近目标；监视失败只记录不报错；200ms 内的变更合并为一次通知。
export class PathWatch {
  private watcher: FSWatcher | null = null
  private watchedPath: string | null = null
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private recheck: NodeJS.Timeout | null = null
  private closed = false
  private lastExists: boolean
  private readonly path: string
  private readonly notify: (changedPaths: string[]) => void

  constructor(path: string, notify: (changedPaths: string[]) => void) {
    this.path = path
    this.notify = notify
    this.lastExists = existsSync(path)
    this.settle()
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.recheck) clearTimeout(this.recheck)
    this.recheck = null
    this.watcher?.close()
    this.watcher = null
  }

  private target(): string | null {
    if (existsSync(this.path)) return this.path
    for (let directory = dirname(this.path); ; directory = dirname(directory)) {
      if (isDirectory(directory)) return directory
      if (dirname(directory) === directory) return null
    }
  }

  // 监视建好之后再看一遍该监视哪里，直到看到的和正在监视的一致。从看路径到监视生效之间
  // 路径又变了的话（一口气建出几层目录时，下一层可能已经在了），那一段变化没有事件：
  // 不再看一遍，监视就一直停在上一层，目标出现了也不知道。一圈对应路径的一次变化，圈数有上限：
  // 路径被别处不停地改来改去时不占着事件循环，停在最后建好的那一层，下一次事件接着挪。
  private arm(): void {
    let armed = false
    for (let moves = 0; moves < maxMovesPerEvent; moves++) {
      const target = this.target()
      if (this.closed || (target === this.watchedPath && this.watcher)) break
      this.watcher?.close()
      this.watcher = null
      this.watchedPath = target
      if (!target) break
      try {
        const watcher = watch(target, { persistent: false }, (_, filename) =>
          this.onEvent(target, filename),
        )
        watcher.on('error', (error) => {
          watcher.close()
          if (this.watcher === watcher) this.watcher = null
          debugLog('fs.watch.failed', { path: this.path, target, error: String(error) })
        })
        this.watcher = watcher
        armed = true
      } catch (error) {
        debugLog('fs.watch.failed', { path: this.path, target, error: String(error) })
        break
      }
    }
    // 只在这一次真的新建了监视时再看：再看时什么都没变就不建新的，也就不会再排下一次。
    // 监视出错停掉了的不再看（照旧只记录），免得出错一次重建一次
    if (!armed || this.closed) return
    if (this.recheck) clearTimeout(this.recheck)
    this.recheck = setTimeout(() => {
      this.recheck = null
      if (!this.closed && this.watcher) this.settle()
    }, armRecheckMs)
    this.recheck.unref()
  }

  // 把监视挪到该在的地方，再看目标在不在：出现或消失时通知目标本身。要在监视落定之后看，
  // 目标正好在挪监视的当口出现时没有事件，只有这里看得出来。
  private settle(): void {
    this.arm()
    const exists = existsSync(this.path)
    if (exists !== this.lastExists) this.queue(this.path)
    this.lastExists = exists
  }

  private onEvent(target: string, filename: string | Buffer | null): void {
    if (this.closed) return
    // 监视的是目标本身时每次变更都通知；监视的是祖先目录时只管目标的出现和消失。
    if (target === this.path)
      this.queue(filename && isDirectory(this.path) ? join(this.path, String(filename)) : this.path)
    this.settle()
  }

  private queue(changedPath: string): void {
    this.pending.add(changedPath)
    this.timer ??= setTimeout(() => {
      this.timer = null
      const changedPaths = [...this.pending].sort()
      this.pending.clear()
      if (!this.closed && changedPaths.length) this.notify(changedPaths)
    }, changeDebounceMs)
  }
}
