// 启动产物只含回调地址和短时授权句柄。机器人 PAT 只在设备响应或私有 gh 配置文件中出现。
// 只装进已注入的会话：gh 与 github.com 的 Git 一律用经理的身份，不看运行目录或目标仓库；
// 身份不可用时报出原因并失败，永不改用宿主 gh 或宿主 Git 凭据。
export const agentHelperProgram = String.raw`
const {connect} = require('node:net')
const {spawn} = require('node:child_process')
const [socket, key, gh, mode, ...args] = process.argv.slice(2)

const reasons = {
  github_agent_credential_unavailable: 'the GitHub credential of the manager identity is revoked, expired or invalid. Re-authorize the identity in Litch: device settings > Unattended > GitHub identities.',
  github_agent_identity_ambiguous: 'the manager identity has more than one active credential. Keep only one in Litch: device settings > Unattended > GitHub identities.',
  github_identity_not_found: 'the GitHub identity bound to this manager no longer exists. Choose an identity in the manager settings.',
  github_agent_injection_off: 'this session no longer uses the manager GitHub identity. Run the command again.',
  github_agent_not_authorized: 'this session no longer uses the manager GitHub identity. Run the command again.',
  github_agent_unavailable: 'the Litch device service did not answer. Retry the command.',
  github_gh_download_unavailable: 'Litch could not download its GitHub CLI. Check the network and retry.',
  github_gh_scope_changed: 'the manager identity changed while the command was starting. Run it again.',
}

function fail(tool, code) {
  const reason = reasons[code] ?? reasons.github_agent_unavailable
  process.stderr.write(tool + ': ' + code + ': ' + reason + ' System ' + tool + ' credentials are not used in this session.\n')
}

function callback(request) {
  return new Promise((resolve) => {
    const conn = connect(socket)
    let body = ''
    const unavailable = {error: 'github_agent_unavailable'}
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

function code(result) {
  return typeof result?.error === 'string' && /^github_[a-z_]+$/.test(result.error)
    ? result.error
    : 'github_agent_unavailable'
}

async function main() {
  if (mode === 'gh') {
    const result = await callback({ mode: 'gh' })
    if (typeof result?.config !== 'string') {
      fail('gh', code(result))
      process.exitCode = 1
      return
    }
    const env = {...process.env}
    for (const name of Object.keys(env)) {
      if (/^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/i.test(name)) delete env[name]
    }
    env.GH_CONFIG_DIR = result.config
    env.GH_HOST = 'github.com'
    const child = spawn(gh, args, {env, stdio: 'inherit', windowsHide: true})
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
  const result = await callback({ mode: 'git', host: 'github.com', protocol: 'https' })
  if (typeof result?.token === 'string' && /^(?:github_pat_[a-zA-Z0-9_]{20,255}|gh[op]_[a-zA-Z0-9]{20,255})$/.test(result.token)) {
    process.stdout.write('username=x-access-token\npassword=' + result.token + '\n\n')
    return
  }
  // quit 让 Git 不再询问其他助手、也不提示输入，避免落到宿主凭据。
  fail('git', code(result))
  process.stdout.write('quit=1\n\n')
}
main().catch(() => { process.exitCode = 1 })
`

export function shellQuoteGithubHelper(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`
}
