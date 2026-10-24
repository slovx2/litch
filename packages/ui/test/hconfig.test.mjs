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

test('从 provider 拉来的型号勾完并回清单：勾掉的去掉、新勾的加在末尾、别的行不动', async () => {
  const { mergeDiscovered, modelLineId } = await import('../src/devices/hconfig/logic.ts')
  assert.equal(modelLineId(' glm-4.6 = GLM 4.6 '), 'glm-4.6')
  const found = [
    { id: 'glm-4.6', title: 'GLM 4.6' },
    { id: 'kimi-k2', title: 'kimi-k2' },
    { id: 'old', title: null },
  ]
  assert.deepEqual(
    mergeDiscovered(
      ['old', 'mine = 我自己的', 'glm-4.6 = 改过的名字'],
      found,
      new Set(['glm-4.6', 'kimi-k2']),
    ),
    ['mine = 我自己的', 'glm-4.6 = 改过的名字', 'kimi-k2'],
  )
  assert.deepEqual(mergeDiscovered([], found, new Set(['glm-4.6'])), ['glm-4.6 = GLM 4.6'])
})

test('拉来的型号带上声明的上下文窗口：新加的、没写窗口的行补上，手写了的不动', async () => {
  const { mergeDiscovered, modelLineId, formatContextWindow } = await import(
    '../src/devices/hconfig/logic.ts'
  )
  assert.equal(modelLineId('deepseek-v4 | 1M'), 'deepseek-v4')
  assert.equal(modelLineId('deepseek-v4 = DeepSeek | 1M'), 'deepseek-v4')
  assert.equal(formatContextWindow(1_000_000), '1M')
  assert.equal(formatContextWindow(128_000), '128K')
  assert.equal(formatContextWindow(131_072), '131072')
  const found = [
    { id: 'deepseek-v4', title: 'DeepSeek V4', contextWindow: 1_000_000 },
    { id: 'deepseek-r2', title: null, contextWindow: 128_000 },
    { id: 'flash', title: null, contextWindow: null },
    // 旧的设备不给 contextWindow
    { id: 'old', title: null },
  ]
  assert.deepEqual(
    mergeDiscovered(
      ['deepseek-v4 = 我的名字', 'deepseek-r2 | 64K', 'mine'],
      found,
      new Set(['deepseek-v4', 'deepseek-r2', 'flash', 'old']),
    ),
    ['deepseek-v4 = 我的名字 | 1M', 'deepseek-r2 | 64K', 'mine', 'flash', 'old'],
  )
  assert.deepEqual(mergeDiscovered([], found, new Set(['deepseek-v4'])), [
    'deepseek-v4 = DeepSeek V4 | 1M',
  ])
})
