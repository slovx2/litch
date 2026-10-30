// 真模型实测的配置副本：只复制认证与模型连接配置，不带个人 MCP、插件、notify、项目或技能。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function prepareEnvironment(root, source, model) {
  const home = join(root, 'home'),
    codexHome = join(root, 'codex')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  const original = readFileSync(join(source, 'config.toml'), 'utf8')
  const lines = original.split('\n')
  let section = ''
  const providers = [],
    top = []
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]/.exec(line)
    if (header) section = header[1]
    if (section === 'model_providers' || section.startsWith('model_providers.'))
      providers.push(line)
    else if (!section && /^\s*model_provider\s*=/.test(line)) top.push(line)
  }
  const catalogLine = lines.find((line) => /^\s*model_catalog_json\s*=/.test(line))
  if (catalogLine) {
    const value = catalogLine.slice(catalogLine.indexOf('=') + 1).trim()
    // 路径使用 TOML 的基本字符串；其他形式明确拒绝，不猜源文件位置。
    const catalog = JSON.parse(value)
    const target = join(codexHome, 'models.json')
    copyFileSync(catalog, target)
    top.push(`model_catalog_json = ${JSON.stringify(target)}`)
  }
  if (existsSync(join(source, 'auth.json')))
    copyFileSync(join(source, 'auth.json'), join(codexHome, 'auth.json'))
  const config = [
    `model = ${JSON.stringify(model)}`,
    ...top,
    'model_reasoning_effort = "high"',
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    'web_search = "disabled"',
    'notify = []',
    '[features]',
    'shell_tool = false',
    'apps = false',
    'multi_agent = false',
    ...providers,
  ].join('\n')
  writeFileSync(join(codexHome, 'config.toml'), config, { mode: 0o600 })
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CODEX_HOME: codexHome,
    TMPDIR: join(root, 'tmp'),
  }
  mkdirSync(env.TMPDIR, { mode: 0o700 })
  // 只传模型提供方明确声明的环境凭据，不记录其值。
  for (const match of config.matchAll(/\benv_key\s*=\s*"([A-Z0-9_]+)"/g)) {
    if (process.env[match[1]]) env[match[1]] = process.env[match[1]]
  }
  return env
}
