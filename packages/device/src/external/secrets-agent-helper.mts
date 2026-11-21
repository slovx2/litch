// 启动产物只含回调地址和短时授权句柄。机器人 PAT 只在设备响应或私有 gh 配置文件中出现。
export const agentHelperProgram = String.raw`
const {connect} = require('node:net')
const {spawn, spawnSync} = require('node:child_process')
const [socket, key, gh, git, hostGh, mode, ...args] = process.argv.slice(2)

function callback(request) {
  return new Promise((resolve) => {
    const conn = connect(socket)
    let body = ''
    const unavailable = request.mode === 'gh' ? {error: 'github_gh_unavailable'} : null
    conn.setEncoding('utf8')
    conn.setTimeout(request.mode === 'gh' ? 120000 : 2000, () => {
      conn.destroy()
      resolve(unavailable)
    })
    conn.on('error', () => resolve(unavailable))
    conn.on('connect', () => conn.write(JSON.stringify({ key, ...request }) + '\n'))
    conn.on('data', (part) => {
      body += part
      if (body.length > 2048) { conn.destroy(); resolve(unavailable) }
    })
    conn.on('end', () => {
      try { resolve(JSON.parse(body)) } catch { resolve(unavailable) }
    })
  })
}

function hostGitEnv() {
  const env = {...process.env}
  const index = Number(env.LITCH_GITHUB_HELPER_CONFIG_INDEX)
  if (Number.isInteger(index) && index >= 0 && Number(env.GIT_CONFIG_COUNT) === index + 3) {
    for (const n of [index, index + 1, index + 2]) {
      delete env['GIT_CONFIG_KEY_' + n]
      delete env['GIT_CONFIG_VALUE_' + n]
    }
    if (index) env.GIT_CONFIG_COUNT = String(index)
    else delete env.GIT_CONFIG_COUNT
    delete env.LITCH_GITHUB_HELPER_CONFIG_INDEX
  }
  return env
}

function repository(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(?:(?:https:\/\/|ssh:\/\/git@)?github\.com\/|git@github\.com:)?([a-z0-9-]+\/[a-z0-9_.-]+)\/?$/i.exec(value.trim())
  return match?.[1]?.replace(/\.git$/i, '')
}

function ghRepository() {
  const customHost = args.findIndex((arg) => arg === '--hostname' || arg.startsWith('--hostname='))
  if (customHost >= 0 && (args[customHost].split('=')[1] ?? args[customHost + 1]) !== 'github.com') return
  const explicit = args.findIndex((arg) => ['-R', '--repo'].includes(arg) || arg.startsWith('--repo='))
  if (explicit >= 0) return repository(args[explicit].split('=')[1] ?? args[explicit + 1])
  if (args[0] === 'api') {
    const endpoint = args.find((arg) => /^\/?repos\/[a-z0-9-]+\/[a-z0-9_.-]+(?:\/|$)/i.test(arg))
    if (endpoint) return repository(endpoint.replace(/^\/?repos\//, '').split('/').slice(0, 2).join('/'))
  }
  const urlArg = args.find((arg) => /^https:\/\/[^\/]+\/[a-z0-9-]+\/[a-z0-9_.-]+\/(?:pull|issues)\//i.test(arg))
  if (urlArg) return repository(urlArg.split('/').slice(0, 5).join('/'))
  if (process.env.GH_REPO) return repository(process.env.GH_REPO)
  const actual = spawnSync(git, ['config', '--get', 'remote.origin.url'], {
    env: hostGitEnv(), encoding: 'utf8', maxBuffer: 4096, timeout: 1200, windowsHide: true,
    stdio: ['ignore','pipe','ignore'],
  })
  return actual.status === 0 ? repository(actual.stdout) : undefined
}

async function main() {
  if (mode === 'gh') {
    const env = {...process.env}
    const repo = ghRepository()
    const result = repo ? await callback({ mode: 'gh', repository: repo }) : null
    if (typeof result?.error === 'string' && /^github_gh_[a-z_]+$/.test(result.error)) {
      process.stderr.write('gh: ' + result.error + '\n')
      process.exitCode = 1
      return
    }
    const config = result?.config
    if (typeof config === 'string') {
      for (const name of Object.keys(env)) {
        if (/^(?:GH_TOKEN|GITHUB_TOKEN)$/i.test(name)) delete env[name]
      }
      env.GH_CONFIG_DIR = config
      env.GH_HOST = 'github.com'
    }
    const binary = typeof config === 'string' ? gh : hostGh
    if (!binary) {
      process.stderr.write('gh: executable not found\n')
      process.exitCode = 127
      return
    }
    const child = spawn(binary, args, {env, stdio: 'inherit', windowsHide: true})
    child.on('error', () => { process.exitCode = 1 })
    child.on('exit', (code) => { process.exitCode = code ?? 1 })
    return
  }
  // 不从 stdin 接受裸主机、URL 或任意命令；只实现 Git GET，忽略 store/erase。
  if (mode !== 'git' || args[0] !== 'get') return
  let data = ''
  for await (const chunk of process.stdin) {
    data += chunk.toString()
    if (data.length > 8192) return
  }
  const fields = new Map(data.split('\n').map((line) => {
    const n = line.indexOf('=')
    return [line.slice(0,n), line.slice(n+1)]
  }))
  if (fields.get('host') !== 'github.com' || fields.get('protocol') !== 'https') return
  const repo = repository(fields.get('path'))
  const result = repo ? await callback({ mode: 'git', host: 'github.com', protocol: 'https', repository: repo }) : null
  if (typeof result?.token === 'string' && /^(?:github_pat_[a-zA-Z0-9_]{20,255}|gh[op]_[a-zA-Z0-9]{20,255})$/.test(result.token)) {
    process.stdout.write('username=x-access-token\npassword=' + result.token + '\n\n')
    return
  }
  // 已运行的会话失去机器人授权后，用原宿主 Git 配置重新查询；避免本工具递归。
  if (!process.env.LITCH_GITHUB_HELPER_CONFIG_INDEX) return
  const child = spawnSync(git, ['credential', 'fill'], {
    env: hostGitEnv(), input: data, encoding: 'utf8', maxBuffer: 16384,
    timeout: 3000, windowsHide: true, stdio: ['pipe','pipe','ignore'],
  })
  if (child.status === 0 && child.stdout) process.stdout.write(child.stdout)
}
main().catch(() => { process.exitCode = 1 })
`

export function shellQuoteGithubHelper(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}
