// harness 详情设置里不靠浏览器就能测的：草稿怎么变成要写的值、改回去算不算改过、MCP 表单和对面的形状互换
// （密钥没改的不带值）、统一模式会换掉哪些文件。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  parseDraft,
  rawOf,
  sameAsStored,
  usableMethods,
  formOf,
  serverOf,
  overwrittenBy,
  effectKey,
} = await import('../src/devices/hconfig/logic.ts')

const spec = (type, extra = {}) => ({
  key: 'k',
  group: 'g',
  type,
  title: { 'zh-CN': 'k', en: 'k' },
  description: null,
  default: null,
  effect: 'none',
  clearable: true,
  readOnly: false,
  readOnlyReason: null,
  minimum: null,
  maximum: null,
  options: [],
  allowCustom: false,
  placeholder: null,
  ...extra,
})
const value = (text) => ({ kind: 'value', value: text })

test('数：空的是不设，填错、不是整数、超范围各有一句', () => {
  const days = spec('integer', { minimum: 1, maximum: 3650 })
  assert.deepEqual(parseDraft(days, value(' 45 ')), { ok: true, value: 45 })
  assert.deepEqual(parseDraft(days, value('')), { ok: true, value: null })
  assert.deepEqual(parseDraft(days, value('abc')), { ok: false, problem: 'hc.bad.number' })
  assert.deepEqual(parseDraft(days, value('1.5')), { ok: false, problem: 'hc.bad.integer' })
  assert.deepEqual(parseDraft(days, value('0')), { ok: false, problem: 'hc.bad.range' })
  assert.deepEqual(parseDraft(spec('number'), value('1.5')), { ok: true, value: 1.5 })
})

test('列表一行一项、JSON 要合规、密钥不能是空的、恢复默认是 null', () => {
  assert.deepEqual(parseDraft(spec('stringList'), value(' a \n\n b\n')), {
    ok: true,
    value: ['a', 'b'],
  })
  assert.deepEqual(parseDraft(spec('json'), value('{"a":1}')), { ok: true, value: { a: 1 } })
  assert.deepEqual(parseDraft(spec('json'), value('{a')), { ok: false, problem: 'hc.bad.json' })
  assert.deepEqual(parseDraft(spec('secret'), value('')), { ok: false, problem: 'hc.bad.empty' })
  assert.deepEqual(parseDraft(spec('string'), { kind: 'clear' }), { ok: true, value: null })
  assert.equal(rawOf(spec('stringList'), ['a', 'b']), 'a\nb')
  assert.equal(rawOf(spec('secret'), { set: true }), '')
})

test('改回原样不算改过；密钥填了就算', () => {
  assert.equal(sameAsStored(spec('stringList'), value('a\nb'), ['a', 'b']), true)
  assert.equal(sameAsStored(spec('integer'), value('30'), 30), true)
  assert.equal(sameAsStored(spec('integer'), value('31'), 30), false)
  assert.equal(sameAsStored(spec('string'), { kind: 'clear' }, undefined), true)
  assert.equal(sameAsStored(spec('secret'), value('x'), { set: true }), false)
  assert.equal(effectKey('harness'), 'hc.effect.harness')
  assert.equal(effectKey('none'), null)
})

test('不认识的登录方式不给入口', () => {
  const methods = ['oauthBrowser', 'apiKey', 'passkey'].map((kind) => ({ id: kind, kind }))
  assert.deepEqual(
    usableMethods(methods).map((one) => one.id),
    ['oauthBrowser', 'apiKey'],
  )
})

test('MCP：读进表单再写回去，密钥没改的不带值，名字还在 secretKeys 里', () => {
  const server = {
    name: 'pg',
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', 'pg@1.0.0'],
    cwd: null,
    env: { DATABASE_URL: '', MODE: 'require' },
    secretKeys: ['DATABASE_URL'],
    url: null,
    headers: {},
    bearerTokenEnvVar: null,
    extra: { timeout: 30 },
    status: null,
  }
  const form = formOf(server, ['stdio', 'http'])
  assert.equal(form.args, '-y\npg@1.0.0')
  assert.deepEqual(form.env[0], { name: 'DATABASE_URL', value: '', secret: true, kept: true })
  const back = serverOf(form)
  assert.equal(back.ok, true)
  assert.deepEqual(back.server.env, { MODE: 'require' })
  assert.deepEqual(back.server.secretKeys, ['DATABASE_URL'])
  assert.deepEqual(back.server.args, ['-y', 'pg@1.0.0'])
  assert.deepEqual(back.server.extra, { timeout: 30 })
  // 填了新值的密钥带上
  form.env[0].value = 'postgres://x'
  assert.equal(serverOf(form).server.env.DATABASE_URL, 'postgres://x')
})

test('MCP：远程的要地址，请求头一行一个；名字、命令、变量名不合规矩各有一句', () => {
  const form = {
    ...formOf(null, ['http']),
    name: 'gh',
    url: 'https://api.example.com/mcp',
    headers: 'X-A: 1\nbad\n',
  }
  const back = serverOf(form)
  assert.equal(back.ok, true)
  assert.deepEqual(back.server.headers, { 'X-A': '1' })
  assert.equal(back.server.command, null)
  assert.deepEqual(serverOf({ ...form, url: 'ftp://x' }), { ok: false, problem: 'hc.mcp.bad.url' })
  assert.deepEqual(serverOf({ ...form, name: 'a b' }), { ok: false, problem: 'hc.mcp.bad.name' })
  const local = { ...formOf(null, ['stdio']), name: 'x' }
  assert.deepEqual(serverOf(local), { ok: false, problem: 'hc.mcp.bad.command' })
  assert.deepEqual(
    serverOf({
      ...local,
      command: 'x',
      env: [{ name: '1A', value: '', secret: false, kept: false }],
    }),
    { ok: false, problem: 'hc.mcp.bad.env' },
  )
})

test('统一模式：换掉存在的、不是底稿、还没指向底稿的那些', () => {
  const info = (path, extra = {}) => ({
    path,
    fileName: path.split('/').at(-1),
    exists: true,
    content: '',
    hash: 'h',
    linkTarget: null,
    overriddenBy: null,
    ...extra,
  })
  const overview = {
    entries: [
      { harness: 'claude', name: 'Claude Code', info: info('/h/.claude/CLAUDE.md'), error: null },
      { harness: 'codex', name: 'Codex', info: info('/h/.codex/AGENTS.md'), error: null },
      {
        harness: 'pi',
        name: 'Pi',
        info: info('/h/.pi/AGENTS.md', { linkTarget: '/h/.claude/CLAUDE.md' }),
        error: null,
      },
      {
        harness: 'dsh',
        name: 'dsh',
        info: info('/h/.dsh/AGENTS.md', { exists: false }),
        error: null,
      },
      { harness: 'oc', name: 'OpenCode', info: null, error: { code: 'remote', message: 'x' } },
    ],
    unified: null,
  }
  assert.deepEqual(
    overwrittenBy(overview, 'claude').map((one) => one.path),
    ['/h/.codex/AGENTS.md'],
  )
  assert.deepEqual(overwrittenBy(overview, 'nobody'), [])
})
