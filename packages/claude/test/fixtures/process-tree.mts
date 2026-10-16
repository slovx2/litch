import { execFileSync } from 'node:child_process'

export interface ProcessRow {
  pid: number
  ppid: number
  pgid: number
  command: string
}

// 直接读操作系统的进程表：判断“进程是否还在”不能只看适配器自己的列表接口。
export function processTable(): ProcessRow[] {
  return execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!match) return []
      return [
        {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          pgid: Number(match[3]),
          command: match[4] ?? '',
        },
      ]
    })
}

// 某个进程的全部后代（不含它自己），按父子关系逐层展开。
export function descendants(root: number, table: ProcessRow[] = processTable()): ProcessRow[] {
  const found: ProcessRow[] = []
  const queue = [root]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const row of table) {
      if (row.ppid !== parent || found.some((entry) => entry.pid === row.pid)) continue
      found.push(row)
      queue.push(row.pid)
    }
  }
  return found
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// 等到给定进程全部消失；超时返回仍然存活的那些。
export async function survivors(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let alive = pids.filter(isAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    alive = alive.filter(isAlive)
  }
  return alive
}

// 等到进程表里出现命令行包含给定片段的进程。
export async function waitForCommand(fragment: string, timeoutMs: number): Promise<ProcessRow> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = processTable().find(
      (entry) => entry.command.includes(fragment) && !entry.command.includes('/bin/ps'),
    )
    if (row) return row
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`进程表里一直没有出现：${fragment}`)
}

// 用例收尾时兜底清理，避免失败的断言把测试进程留在机器上。
export function killAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}
