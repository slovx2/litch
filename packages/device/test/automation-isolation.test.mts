import './helpers.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { automationSkill } from '../../protocol/src/automation-skills.mjs'
import { EXTENSION } from '../../protocol/src/device.mjs'
import {
  automationSkillPath,
  installAutomationSkill,
  installSharedAutomationSkills,
  removeAutomationSkills,
  sharedAutomationRoots,
} from '../../shared/src/automation-skills.mjs'
import { ResumeTools } from '../src/resume-tools.mjs'
import { prepareSessionTools } from '../src/session-client-tools.mjs'

const skill = (namespace: string) => {
  const result = automationSkill(namespace)
  assert.ok(result)
  return result
}

test('检查脚本只导入 helpers、没有测试运行器预加载，也不会继承个人配置', () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  delete env.LITCH_TEST_ISOLATED
  env.NODE_ENV = 'test'
  // 故意传入真实目录；子进程必须在调用安装器之前自行覆盖。
  env.HOME = env.USERPROFILE = userInfo().homedir
  env.CODEX_HOME = join(userInfo().homedir, '.codex')
  env.CLAUDE_CONFIG_DIR = join(userInfo().homedir, '.claude')
  const script = `
    await import(${JSON.stringify(new URL('./helpers.mjs', import.meta.url).href)});
    const {mkdirSync, writeFileSync, chmodSync} = await import('node:fs');
    const {join} = await import('node:path');
    const cache = join(process.env.HOME, 'go/pkg/mod/example');
    mkdirSync(cache, {recursive:true});
    writeFileSync(join(cache, 'go.mod'), 'module example');
    chmodSync(cache, 0o555);
    const {installSharedAutomationSkills} = await import(${JSON.stringify(new URL('../../shared/src/automation-skills.mjs', import.meta.url).href)});
    console.log(JSON.stringify(installSharedAutomationSkills()));
  `
  const paths = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env,
      encoding: 'utf8',
      timeout: 10_000,
    }),
  ) as string[]
  assert.equal(paths.length, 4)
  for (const path of paths) {
    assert.ok(!path.startsWith(join(userInfo().homedir, '.agents')))
    assert.ok(!path.startsWith(join(userInfo().homedir, '.claude')))
    assert.equal(existsSync(path), false, '子进程退出时清理临时 HOME')
  }
})

test('直接复用设备夹具也隔离 HOME；新建和恢复的隐式安装只写临时配置', () => {
  assert.notEqual(realpathSync(homedir()), realpathSync(userInfo().homedir))
  assert.equal(process.env.CODEX_HOME, join(homedir(), '.codex'))
  assert.equal(process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude'))
  const values = { 'tools.browser': true, 'tools.computer': true }
  const verify = () => {
    for (const root of sharedAutomationRoots())
      for (const name of ['litch_browser', 'litch_computer'])
        assert.ok(automationSkillPath(root, skill(name)))
  }
  prepareSessionTools({}, 'claude-code', { extensions: [EXTENSION.clientTools] }, false, values, {
    tasks: false,
  })
  verify()
  for (const root of sharedAutomationRoots()) removeAutomationSkills(root)
  new ResumeTools(
    () => values,
    { setTools() {} },
    () => false,
  ).tools('claude-code', [])
  verify()
})

test('测试环境拒绝显式真实 HOME、直接安装和卸载；检查先于锁和写入', () => {
  const home = userInfo().homedir
  assert.throws(() => installSharedAutomationSkills(home), /测试禁止写入真实用户/)
  for (const directory of ['.agents', '.claude', '.codex']) {
    const root = join(home, directory, 'skills')
    assert.throws(
      () => installAutomationSkill(root, skill('litch_browser')),
      /测试禁止写入真实用户/,
    )
    assert.throws(() => removeAutomationSkills(root), /测试禁止写入真实用户/)
  }
})

test('临时 HOME 里的链接不能绕过真实配置树保护', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-guard-'))
  try {
    const alias = join(dir, 'account')
    symlinkSync(userInfo().homedir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => installSharedAutomationSkills(alias), /测试禁止写入真实用户/)
    assert.throws(
      () => installAutomationSkill(join(alias, '.agents', 'skills'), skill('litch_browser')),
      /测试禁止写入真实用户/,
    )
    assert.equal(existsSync(join(dir, '.agents')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
