import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listClaudeHooks } from '../src/claude-capabilities.mjs'
import { settingsEnvValue } from '../src/claude-setting-layers.mjs'
import {
  applyPromptCacheTtl,
  claudePlansLocation,
  claudePromptCacheTtl,
  claudeSettingSources,
  claudeThreadIdHeader,
  claudeThreadIdHeaderEnv,
  resolveRuntimeConfig,
} from '../src/runtime-config.mjs'
import { nativeSkillOverrides } from '../src/skill-catalog.mjs'

test('CHA_CLAUDE_SETTING_SOURCES：默认三层都读，可只读其中几层，认不出的值启动就报错', () => {
  assert.deepEqual(claudeSettingSources({}), ['user', 'project', 'local'])
  assert.deepEqual(claudeSettingSources({ CHA_CLAUDE_SETTING_SOURCES: '  ' }), [
    'user',
    'project',
    'local',
  ])
  assert.deepEqual(claudeSettingSources({ CHA_CLAUDE_SETTING_SOURCES: 'user' }), ['user'])
  assert.deepEqual(claudeSettingSources({ CHA_CLAUDE_SETTING_SOURCES: ' User , local ' }), [
    'user',
    'local',
  ])
  for (const bad of ['user,workspace', 'user,,local', 'user,user', 'none'])
    assert.throws(
      () => claudeSettingSources({ CHA_CLAUDE_SETTING_SOURCES: bad }),
      /CHA_CLAUDE_SETTING_SOURCES 无效/,
    )
  assert.throws(
    () => resolveRuntimeConfig({ CHA_CLAUDE_SETTING_SOURCES: 'policy' }),
    /CHA_CLAUDE_SETTING_SOURCES 无效/,
  )
  assert.deepEqual(resolveRuntimeConfig({}).native, {
    settingSources: ['user', 'project', 'local'],
    plansLocation: 'workspace',
    threadIdHeader: false,
    promptCacheTtl: 'default',
  })
})

test('CHA_CLAUDE_PLANS_LOCATION：默认放工作区，config 放 Claude Code 自己的配置目录，别的值报错', () => {
  assert.equal(claudePlansLocation({}), 'workspace')
  assert.equal(claudePlansLocation({ CHA_CLAUDE_PLANS_LOCATION: 'workspace' }), 'workspace')
  assert.equal(claudePlansLocation({ CHA_CLAUDE_PLANS_LOCATION: 'Config' }), 'config')
  assert.throws(
    () => claudePlansLocation({ CHA_CLAUDE_PLANS_LOCATION: '/srv/plans' }),
    /CHA_CLAUDE_PLANS_LOCATION 无效/,
  )
})

test('CHA_CLAUDE_THREAD_ID_HEADER：默认关、关着不加头；开着合进原有的自定义头', () => {
  assert.equal(claudeThreadIdHeader({}), false)
  assert.equal(claudeThreadIdHeader({ CHA_CLAUDE_THREAD_ID_HEADER: '0' }), false)
  assert.equal(claudeThreadIdHeader({ CHA_CLAUDE_THREAD_ID_HEADER: '1' }), true)
  assert.throws(
    () => claudeThreadIdHeader({ CHA_CLAUDE_THREAD_ID_HEADER: 'maybe' }),
    /CHA_CLAUDE_THREAD_ID_HEADER 无效/,
  )
  assert.deepEqual(claudeThreadIdHeaderEnv({ ANTHROPIC_CUSTOM_HEADERS: 'x-a: 1' }, 't1', {}), {})
  assert.deepEqual(claudeThreadIdHeaderEnv({}, 't1', { CHA_CLAUDE_THREAD_ID_HEADER: '1' }), {
    ANTHROPIC_CUSTOM_HEADERS: 'thread-id: t1',
  })
  assert.deepEqual(
    claudeThreadIdHeaderEnv(
      { ANTHROPIC_CUSTOM_HEADERS: 'x-a: 1\r\nThread-Id: old\n\nx-b: 2' },
      't2',
      { CHA_CLAUDE_THREAD_ID_HEADER: '1' },
    ),
    { ANTHROPIC_CUSTOM_HEADERS: 'x-a: 1\nx-b: 2\nthread-id: t2' },
  )
})

test('CHA_CLAUDE_SETTING_SOURCES 也管入口自己读的设置：钩子列表、技能开关、设置里的 env', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'setting-sources-adapter-'))
  const saved = {
    sources: process.env.CHA_CLAUDE_SETTING_SOURCES,
    config: process.env.CLAUDE_CONFIG_DIR,
  }
  try {
    const config = join(directory, 'config')
    const project = join(directory, 'project')
    await mkdir(config, { recursive: true })
    await mkdir(join(project, '.claude'), { recursive: true })
    const hooks = (command: string) => ({
      hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] },
    })
    await writeFile(
      join(config, 'settings.json'),
      JSON.stringify({
        ...hooks('user-hook'),
        skillOverrides: { a: 'off' },
        env: { ANTHROPIC_CUSTOM_HEADERS: 'x-user: 1' },
      }),
    )
    await writeFile(
      join(project, '.claude', 'settings.json'),
      JSON.stringify({
        ...hooks('project-hook'),
        skillOverrides: { b: 'off' },
        env: { ANTHROPIC_CUSTOM_HEADERS: 'x-project: 1' },
      }),
    )
    process.env.CLAUDE_CONFIG_DIR = config
    const commands = () =>
      JSON.stringify(listClaudeHooks({ cwds: [project] }))
        .match(/(user|project)-hook/g)
        ?.sort()
    delete process.env.CHA_CLAUDE_SETTING_SOURCES
    assert.deepEqual(commands(), ['project-hook', 'user-hook'])
    assert.deepEqual({ ...nativeSkillOverrides(project) }, { a: 'off', b: 'off' })
    assert.equal(settingsEnvValue(project, 'ANTHROPIC_CUSTOM_HEADERS'), 'x-project: 1')
    process.env.CHA_CLAUDE_SETTING_SOURCES = 'user'
    assert.deepEqual(commands(), ['user-hook'])
    assert.deepEqual({ ...nativeSkillOverrides(project) }, { a: 'off' })
    assert.equal(settingsEnvValue(project, 'ANTHROPIC_CUSTOM_HEADERS'), 'x-user: 1')
    process.env.CHA_CLAUDE_SETTING_SOURCES = 'project'
    assert.deepEqual(commands(), ['project-hook'])
  } finally {
    for (const [key, value] of [
      ['CHA_CLAUDE_SETTING_SOURCES', saved.sources],
      ['CLAUDE_CONFIG_DIR', saved.config],
    ] as const)
      if (value == null) delete process.env[key]
      else process.env[key] = value
    await rm(directory, { recursive: true, force: true })
  }
})

test('CHA_CLAUDE_PROMPT_CACHE_TTL：默认 default、什么都不设；1h 设 CLI 自己的三个变量，用户设过的照旧；别的值报错', () => {
  assert.equal(claudePromptCacheTtl({}), 'default')
  assert.equal(claudePromptCacheTtl({ CHA_CLAUDE_PROMPT_CACHE_TTL: ' Default ' }), 'default')
  assert.equal(claudePromptCacheTtl({ CHA_CLAUDE_PROMPT_CACHE_TTL: '1H' }), '1h')
  for (const bad of ['1', '5m', '0', 'on'])
    assert.throws(
      () => resolveRuntimeConfig({ CHA_CLAUDE_PROMPT_CACHE_TTL: bad }),
      /CHA_CLAUDE_PROMPT_CACHE_TTL 无效/,
    )
  const untouched: NodeJS.ProcessEnv = { ANTHROPIC_BETAS: 'user-beta' }
  applyPromptCacheTtl(untouched)
  assert.deepEqual(untouched, { ANTHROPIC_BETAS: 'user-beta' })
  const hour: NodeJS.ProcessEnv = { CHA_CLAUDE_PROMPT_CACHE_TTL: '1h' }
  applyPromptCacheTtl(hour)
  applyPromptCacheTtl(hour)
  assert.deepEqual(hour, {
    CHA_CLAUDE_PROMPT_CACHE_TTL: '1h',
    ENABLE_PROMPT_CACHING_1H: '1',
    CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '5m',
  })
  // 入口不再自己往 ANTHROPIC_BETAS 补 beta
  assert.equal('ANTHROPIC_BETAS' in hour, false)
  const mine: NodeJS.ProcessEnv = {
    CHA_CLAUDE_PROMPT_CACHE_TTL: '1h',
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: '1h',
  }
  applyPromptCacheTtl(mine)
  assert.equal(mine.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, '1h')
})
