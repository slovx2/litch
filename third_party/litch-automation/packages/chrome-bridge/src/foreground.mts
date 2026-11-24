// 受控页面自己打开新页面时 Chrome 会抢走 macOS 前台（见扩展 foreground.mts）。宿主在每次代理输入
// 前记下当时的前台应用，扩展报告抢前台后再把前台还给它。只用系统自带工具，不需要辅助功能或自动化权限：
// lsappinfo 读前台应用，osascript 的 JavaScript 桥调用 NSRunningApplication.activate（不发 Apple 事件）。
import { execFile } from 'node:child_process'

export interface ForegroundKeeper {
  /** 代理输入即将派发：记下当时的前台应用。不阻塞输入。 */
  note(): void
  /** 扩展报告 Chrome 被受控页面拉到了前台：把前台还给最近记下的应用。 */
  restore(): Promise<boolean>
}

type Run = (file: string, args: string[]) => Promise<string>

const run: Run = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 2_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    ),
  )

/** 记下的前台应用只在这段时间内有效，与扩展识别的输入窗口一致并留出余量。 */
const NOTE_MS = 7_000

export async function frontmostPid(exec: Run = run): Promise<number | null> {
  const asn = (await exec('/usr/bin/lsappinfo', ['front'])).trim()
  if (!/^ASN:0x[0-9a-f]+-0x[0-9a-f]+:?$/i.test(asn)) return null
  const info = await exec('/usr/bin/lsappinfo', ['info', '-only', 'pid', asn])
  const pid = Number(/"pid"\s*=\s*(\d+)/.exec(info)?.[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

export function activateScript(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process id')
  return [
    "ObjC.import('AppKit')",
    `const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid})`,
    'app.isNil() || app.terminated ? false : app.activateWithOptions(0)',
  ].join('\n')
}

export function macForegroundKeeper(
  options: { exec?: Run; now?: () => number } = {},
): ForegroundKeeper {
  const exec = options.exec ?? run
  const now = options.now ?? Date.now
  let noted: { at: number; pid: Promise<number | null> } | null = null
  return {
    note() {
      const pid = frontmostPid(exec).catch(() => null)
      noted = { at: now(), pid }
    },
    async restore() {
      const last = noted
      if (!last || now() - last.at > NOTE_MS) return false
      const previous = await last.pid
      if (!previous) return false
      const current = await frontmostPid(exec).catch(() => null)
      // 输入前 Chrome 本来就在前台，或用户已经切走：都不动。
      if (current === null || current === previous) return false
      await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', activateScript(previous)])
      return true
    },
  }
}
