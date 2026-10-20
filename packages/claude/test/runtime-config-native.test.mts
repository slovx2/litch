import assert from 'node:assert/strict'
import test from 'node:test'
import {
  claudePlansLocation,
  claudeSettingSources,
  claudeThreadIdHeader,
  claudeThreadIdHeaderEnv,
  resolveRuntimeConfig,
} from '../src/runtime-config.mjs'

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
