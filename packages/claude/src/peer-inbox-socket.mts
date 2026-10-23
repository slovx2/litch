// 本机收件箱（Claude Code 的跨会话消息）的固定地址。CLI 默认按进程号起套接字（<目录>/cc-socks/<pid>.sock），
// 别的会话记下的地址（ListAgents 列出的、收到的消息信封里的 from）在 Litch 换了进程之后就作废：打断回合、
// 启动配置变了、空闲回收后再开回合，都会起新进程。入口经 CLI 的 --messaging-socket-path 给每个会话一个
// 不随进程变的地址，换了进程照样发得到。
import { lstatSync, mkdirSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'

// CLI 认的套接字路径上限（字节），超了它自己也会退到 /tmp/cc-socks-<uid>/ 下
const MAX_SOCKET_PATH = 103

/** 会话的固定地址候选：先照 CLI 的默认目录，太长时照它的退路目录；会话键不像文件名、或在 Windows 上时为空 */
export function peerInboxSocketPaths(
  key: string,
  env: NodeJS.ProcessEnv,
  uid: number = process.getuid?.() ?? 0,
): string[] {
  if (process.platform === 'win32' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) return []
  const file = `litch-${key}.sock`
  const base = env.XDG_RUNTIME_DIR || env.CLAUDE_CODE_TMPDIR || '/tmp'
  return [join(base, 'cc-socks', file), join('/tmp', `cc-socks-${uid}`, file)].filter(
    (path, index, all) => Buffer.byteLength(path) <= MAX_SOCKET_PATH && all.indexOf(path) === index,
  )
}

/**
 * 给即将起的 CLI 挑一个能用的固定地址；都不能用时为 null，CLI 照旧自己按进程号起。
 * 显式地址出了问题 CLI 会直接起不来（目录不是自己的私有目录、地址上已有进程在听），所以这里先替它查一遍：
 * 目录不在就建成 0700；上一个进程被强杀留下的套接字文件不算占用，CLI 会删掉重建
 */
export async function claimPeerInboxSocket(
  key: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const uid = process.getuid?.()
  for (const path of peerInboxSocketPaths(key, env, uid)) {
    if (!privateDirectory(dirname(path), uid)) continue
    if (await listening(path)) return null
    return path
  }
  return null
}

function privateDirectory(dir: string, uid: number | undefined): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    return (
      stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0
    )
  } catch {
    return false
  }
}

// 和 CLI 判断“地址上有活进程”的办法一样：连得上就是有
function listening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path })
    const done = (live: boolean): void => {
      socket.destroy()
      resolve(live)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(250, () => done(false))
  })
}
