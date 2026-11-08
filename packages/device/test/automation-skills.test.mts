import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AUTOMATION_GUIDE_NAMESPACE,
  automationGuide,
  automationSkill,
} from '../../protocol/src/automation-skills.mjs'
import { browserToolsSpec } from '../../protocol/src/client-tools-browser.mjs'
import {
  installAutomationSkill,
  installSharedAutomationSkills,
  removeAutomationSkills,
} from '../../shared/src/automation-skills.mjs'
import { resolveAutomationTools, withAutomationGuide } from '../../shared/src/automation-tools.mjs'
import { registerAutomationGuide } from '../src/automation-guide.mjs'
import { codexAutomationSkills } from '../src/codex-automation-skills.mjs'
import type { DeviceToolHandler } from '../src/device-tools.mjs'

const isolated = (fn: (home: string) => void) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'auto-skills-')))
  try {
    fn(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
test('两个共享目录以源覆盖，无标记/手改/新增文件均更新；其他技能不动', () =>
  isolated((home) => {
    const root = join(home, '.agents/skills'),
      skill = automationSkill('litch_browser')!
    const dir = join(root, skill.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'user edit')
    writeFileSync(join(dir, 'extra.txt'), 'old')
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'other/SKILL.md'), 'keep')
    assert.equal(installSharedAutomationSkills(home).length, 4)
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), skill.files['SKILL.md'])
    assert.equal(existsSync(join(dir, 'extra.txt')), false)
    writeFileSync(join(dir, 'SKILL.md'), 'changed again')
    assert.equal(installSharedAutomationSkills(home).length, 4)
    assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), skill.files['SKILL.md'])
    assert.equal(readFileSync(join(root, 'other/SKILL.md'), 'utf8'), 'keep')
    writeFileSync(join(dir, 'SKILL.md'), 'edited before uninstall')
    assert.equal(removeAutomationSkills(root).length, 2)
    assert.equal(existsSync(join(root, 'other/SKILL.md')), true)
  }))
test('更新事务中断后恢复；写入失败只回退 guide', () =>
  isolated((home) => {
    const root = join(home, '.agents/skills'),
      skill = automationSkill('litch_browser')!
    installSharedAutomationSkills(home)
    renameSync(join(root, skill.name), join(root, `.${skill.name}.litch-old`))
    mkdirSync(join(root, `.${skill.name}.litch-new`))
    writeFileSync(join(root, `.${skill.name}.litch-new/partial`), 'interrupted')
    assert.ok(installAutomationSkill(root, skill))
    assert.equal(existsSync(join(root, `.${skill.name}.litch-old`)), false)
    const bad = join(home, 'not-directory')
    writeFileSync(bad, 'x')
    assert.equal(installAutomationSkill(bad, skill), null)
    const raw = withAutomationGuide([browserToolsSpec(true)])
    const result = resolveAutomationTools(raw, 'claude', {
      env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'custom') },
    })
    assert.match(JSON.stringify(result), /Before use, read litch_automation.guide/)
  }))

test('替换技能链接本身，不写或清理链接指向的其他目录', () =>
  isolated((home) => {
    if (process.platform === 'win32') return
    const root = join(home, '.agents/skills')
    const other = join(home, 'other')
    mkdirSync(root, { recursive: true })
    mkdirSync(other)
    writeFileSync(join(other, 'SKILL.md'), 'outside')
    symlinkSync(other, join(root, 'litch-browser-automation'))
    assert.equal(installSharedAutomationSkills(home).length, 4)
    assert.equal(readFileSync(join(other, 'SKILL.md'), 'utf8'), 'outside')
    removeAutomationSkills(root)
    assert.equal(readFileSync(join(other, 'SKILL.md'), 'utf8'), 'outside')
  }))
test('原生共享目录只读发现与未知入口兜底，独立适配器不缩短', () =>
  isolated((home) => {
    installSharedAutomationSkills(home)
    const full = [browserToolsSpec(true)],
      raw = withAutomationGuide(full)
    for (const engine of ['claude', 'pi', 'dsh', 'opencode', 'gemini', 'qwen']) {
      const result = resolveAutomationTools(raw, engine, { env: { HOME: home } })
      assert.equal(result.length, 2)
      assert.match(JSON.stringify(result), /Read litch-browser-automation skill/)
    }
    for (const engine of ['acp', 'agy'])
      assert.match(
        JSON.stringify(resolveAutomationTools(raw, engine, { env: { HOME: home } })),
        /litch_automation.guide/,
      )
    assert.deepEqual(resolveAutomationTools(full, 'pi', { env: { HOME: home } }), full)
  }))
test('Codex 使用原生发现结果，禁用/失败用 guide，不改 CODEX_HOME', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'auto-skills-')))
  try {
    installSharedAutomationSkills(home)
    let enabled = true
    const context = {
      ask: async () => ({
        data: [
          {
            skills: [
              {
                name: 'litch-browser-automation',
                path: join(home, '.agents/skills/litch-browser-automation/SKILL.md'),
                enabled,
              },
            ],
          },
        ],
      }),
      store: { instructions: () => null, setInstructions: () => {}, tools: () => null },
      log: () => {},
    }
    const params = { dynamicTools: withAutomationGuide([browserToolsSpec(true)]), cwd: home }
    assert.match(
      JSON.stringify(await codexAutomationSkills(params, context)),
      /Read litch-browser-automation skill/,
    )
    enabled = false
    assert.match(
      JSON.stringify(await codexAutomationSkills(params, context)),
      /litch_automation.guide/,
    )
    assert.equal(existsSync(join(home, '.codex')), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
test('设备 guide 完整返回同份正文，不记录先读状态', async () => {
  let handler: DeviceToolHandler | undefined
  registerAutomationGuide({
    register(ns, fn) {
      assert.equal(ns, AUTOMATION_GUIDE_NAMESPACE)
      handler = fn
    },
    has: () => true,
    namespaces: () => [],
  })
  for (const topic of ['browser', 'computer'] as const) {
    const result = await handler!(
      {
        harness: 'acp',
        threadId: 't',
        turnId: 'u',
        callId: 'c',
        namespace: AUTOMATION_GUIDE_NAMESPACE,
        tool: 'guide',
        arguments: { topic },
      },
      { signal: new AbortController().signal },
    )
    assert.deepEqual(result, {
      success: true,
      contentItems: [{ type: 'inputText', text: automationGuide(topic) }],
    })
  }
})
