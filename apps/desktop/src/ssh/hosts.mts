// 从用户的 ssh 配置里找出可以添加的主机：读配置文件里的 Host 行（跟着 Include 走），
// 再让 ssh 自己把每个别名解析一遍（ssh -G，只解析、不连接），拿到主机名、用户和端口。
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DiscoveredHost } from '@litch/core'

/** 最多列这么多台，配置再长也不多列 */
const MAX_HOSTS = 200
const MAX_FILES = 200
/** 同时解析几个别名 */
const PARALLEL = 6

/** 代码托管站点的 ssh 入口不是能连上去干活的机器，不列 */
const NOT_MACHINES =
  /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|gitee\.com|ssh\.dev\.azure\.com)$/i

const wild = (pattern: string): boolean => /[*?!]/.test(pattern)

/** 把一行拆成词，认双引号 */
function words(line: string): string[] {
  const out: string[] = []
  for (const match of line.matchAll(/"([^"]*)"|(\S+)/g)) out.push(match[1] ?? match[2] ?? '')
  return out
}

/** 展开带通配符的路径。只认 * 和 ?，够 Include 用了 */
function expand(pattern: string): string[] {
  const parts = pattern.split('/')
  let found = [parts[0] === '' ? '/' : (parts[0] ?? '')]
  for (const part of parts.slice(1)) {
    if (!part) continue
    if (!/[*?]/.test(part)) {
      found = found.map((base) => join(base, part))
      continue
    }
    const shape = new RegExp(
      `^${part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    )
    const next: string[] = []
    for (const base of found) {
      try {
        for (const name of readdirSync(base).sort()) {
          // 和 shell 一样，通配符不匹配以点开头的名字
          if (!name.startsWith('.') && shape.test(name)) next.push(join(base, name))
        }
      } catch {
        // 这一层不存在或者读不了，跳过
      }
    }
    found = next
  }
  return found
}

/** 读一份配置文件，把里面的别名按出现的顺序收进 aliases */
function collect(file: string, aliases: string[], seen: Set<string>): void {
  if (seen.has(file) || seen.size >= MAX_FILES) return
  seen.add(file)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    // 关键字和值之间可以是空格，也可以是等号
    const [keyword = '', ...rest] = words(line.replace(/^(\S+?)\s*=\s*/, '$1 '))
    if (/^include$/i.test(keyword)) {
      for (const entry of rest) {
        const path = entry.startsWith('~/')
          ? join(homedir(), entry.slice(2))
          : isAbsolute(entry)
            ? entry
            : // 相对路径是相对用户的 ssh 目录，不是相对当前这份文件
              join(homedir(), '.ssh', entry)
        for (const next of expand(path)) collect(next, aliases, seen)
      }
    } else if (/^host$/i.test(keyword)) {
      // 一行上的几个名字通常是同一台机器的几种叫法：取第一个不带通配符的
      const alias = rest.find((pattern) => !wild(pattern))
      if (alias && !alias.startsWith('-') && !aliases.includes(alias)) aliases.push(alias)
    }
  }
}

/** 让 ssh 把一个别名解析成主机名、用户、端口。解析不了的各项都是 null */
function resolve(alias: string, config: string | undefined): Promise<DiscoveredHost> {
  return new Promise((done) => {
    const args = [...(config ? ['-F', config] : []), '-G', '--', alias]
    execFile('ssh', args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
      const host: DiscoveredHost = { alias, host: null, user: null, port: null }
      if (!error) {
        for (const line of stdout.split('\n')) {
          const [key, value] = line.split(' ', 2)
          if (!value) continue
          if (key === 'hostname') host.host = value
          else if (key === 'user') host.user = value
          else if (key === 'port') host.port = Number(value) || null
        }
      }
      done(host)
    })
  })
}

export async function discoverHosts(): Promise<DiscoveredHost[]> {
  const config = process.env.LITCH_SSH_CONFIG
  const aliases: string[] = []
  collect(config ?? join(homedir(), '.ssh', 'config'), aliases, new Set())
  const wanted = aliases.slice(0, MAX_HOSTS)
  const hosts: DiscoveredHost[] = new Array(wanted.length)
  let next = 0
  const worker = async () => {
    while (next < wanted.length) {
      const index = next++
      hosts[index] = await resolve(wanted[index] as string, config)
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))
  return hosts.filter(
    (host) => !(host.host && NOT_MACHINES.test(host.host)) && !(host.user === 'git' && host.host),
  )
}
