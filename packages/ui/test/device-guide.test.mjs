// 远程设备没连上之后“该怎么办”：核心说了是哪一份就给哪一份，没说的按阶段给；本机没有这些。
// 不起浏览器：guide.ts 只有判断。跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { guideOf, INSTALL_SERVICE, sshCommand } = await import('../src/devices/guide.ts')
const { zhCN: zh } = await import('../src/i18n/zh-CN.ts')
const { en } = await import('../src/i18n/en.ts')

const ALIAS = { kind: 'alias', alias: 'build-01' }
const HOST = { kind: 'host', host: '10.0.0.8', port: 2222, user: 'dev', keyFile: '~/.ssh/work' }
const failure = (stage, guide) => ({
  stage,
  text: '原因',
  detail: null,
  retrying: false,
  ...(guide ? { guide } : {}),
})
const keysOf = (steps) => steps.map((step) => step.text)
const commandsOf = (steps) => steps.flatMap((step) => (step.command === null ? [] : [step.command]))

test('什么都没装：两条路都给，设备服务排在前面', () => {
  const steps = guideOf(failure('notInstalled', 'install'), ALIAS)
  assert.deepEqual(keysOf(steps), [
    'devices.guide.install',
    'devices.guide.install.service',
    'devices.guide.install.codex',
  ])
  assert.deepEqual(commandsOf(steps), [INSTALL_SERVICE, 'npm install -g @openai/codex'])
})

test('只和 codex 有关的：坏了就重装，旧了就升级，不提设备服务', () => {
  assert.deepEqual(commandsOf(guideOf(failure('notInstalled', 'installCodex'), ALIAS)), [
    'npm install -g @openai/codex',
  ])
  assert.deepEqual(commandsOf(guideOf(failure('outdated', 'upgradeCodex'), ALIAS)), [
    'npm install -g @openai/codex@latest',
  ])
})

test('适配器太旧：重跑安装脚本就是升级，另给 Homebrew 的那一句；之后的事只说不给命令', () => {
  const steps = guideOf(failure('outdated', 'upgradeService'), ALIAS)
  assert.deepEqual(commandsOf(steps), [INSTALL_SERVICE, 'brew upgrade codex-harness-adapter'])
  assert.equal(steps.at(-1)?.command, null)
})

test('旧服务在跑：只告诉人怎么重启，不替他停', () => {
  const steps = guideOf(failure('outdated', 'restartService'), ALIAS)
  assert.deepEqual(keysOf(steps), [
    'devices.guide.restartService',
    'devices.guide.restartService.manual',
  ])
  assert.deepEqual(commandsOf(steps), ['brew services restart codex-harness-adapter'])
  // 给出的命令里没有替用户停服务、杀进程的
  for (const guide of [
    'install',
    'installCodex',
    'upgradeCodex',
    'upgradeService',
    'restartService',
  ]) {
    for (const command of commandsOf(guideOf(failure('outdated', guide), ALIAS))) {
      assert.doesNotMatch(command, /device-stop|kill|sudo/)
    }
  }
})

test('核心没说是哪一份：主机密钥、认证按阶段给；别的阶段没有可说的', () => {
  assert.deepEqual(commandsOf(guideOf(failure('hostKey'), ALIAS)), ['ssh build-01'])
  assert.deepEqual(commandsOf(guideOf(failure('hostKey'), HOST)), [
    'ssh -p 2222 -i ~/.ssh/work dev@10.0.0.8',
  ])
  assert.equal(sshCommand(HOST), 'ssh -p 2222 -i ~/.ssh/work dev@10.0.0.8')
  assert.deepEqual(commandsOf(guideOf(failure('auth'), HOST)), ['ssh-add ~/.ssh/work'])
  assert.deepEqual(commandsOf(guideOf(failure('auth'), ALIAS)), ['ssh-add ~/.ssh/id_ed25519'])
  for (const stage of ['unreachable', 'startFailed', 'handshake', 'notInstalled', 'outdated']) {
    assert.deepEqual(guideOf(failure(stage), ALIAS), [], stage)
  }
})

test('本机没连上：这些说的都是经 ssh 连的那台机器，一条都不给', () => {
  for (const guide of ['install', 'upgradeService', 'restartService']) {
    assert.deepEqual(guideOf(failure('notInstalled', guide), null), [])
  }
  assert.deepEqual(guideOf(failure('auth'), null), [])
})

test('每一步的说明两种语言都有', () => {
  const guides = ['install', 'installCodex', 'upgradeCodex', 'upgradeService', 'restartService']
  const steps = [
    ...guides.flatMap((guide) => guideOf(failure('outdated', guide), ALIAS)),
    ...guideOf(failure('hostKey'), ALIAS),
    ...guideOf(failure('auth'), ALIAS),
  ]
  for (const key of keysOf(steps)) {
    assert.equal(typeof zh[key], 'string', `中文缺 ${key}`)
    assert.equal(typeof en[key], 'string', `英文缺 ${key}`)
  }
})
