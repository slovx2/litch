// 出码对话框里不靠浏览器就能测的那几块（devices/pairing.ts）：地址表单的检查、原配置的写法、倒计时、确认码、
// 出码失败认哪一种、没开 SSH 服务按系统给哪一句、什么时候自动换码；两种语言的文案键齐全。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const {
  addressLine,
  checkDraft,
  codeText,
  countdown,
  draftOf,
  failureOf,
  finalState,
  refreshes,
  sameAddress,
  showsSaid,
  sshOffHint,
} = await import('../src/devices/pairing.ts')
const { translator } = await import('../src/i18n/index.ts')

const address = { name: '开发机', host: 'device-ts', port: 2222, user: 'dev' }

test('地址和表单来回换；四栏各自查，说出是哪一栏', () => {
  const draft = draftOf(address)
  assert.deepEqual(draft, { name: '开发机', host: 'device-ts', port: '2222', user: 'dev' })
  assert.deepEqual(checkDraft(draft), { address })
  assert.deepEqual(checkDraft({ ...draft, name: '  开发机 ', host: ' device-ts ' }), { address })
  const field = (patch) => {
    const result = checkDraft({ ...draft, ...patch })
    return 'field' in result ? result.field : null
  }
  assert.equal(field({ name: '' }), 'name')
  assert.equal(field({ name: 'x'.repeat(65) }), 'name')
  assert.equal(field({ host: '' }), 'host')
  assert.equal(field({ host: 'a b' }), 'host')
  assert.equal(field({ host: '-oProxyCommand=x' }), 'host')
  assert.equal(field({ host: 'dev@device-ts' }), 'host')
  assert.equal(field({ port: '0' }), 'port')
  assert.equal(field({ port: '65536' }), 'port')
  assert.equal(field({ port: '22.5' }), 'port')
  assert.equal(field({ port: 'abc' }), 'port')
  assert.equal(field({ user: '' }), 'user')
  assert.equal(field({ user: '-l' }), 'user')
  assert.equal(field({ port: ' 22 ' }), null)
})

test('原配置写成一行；比较地址', () => {
  assert.equal(addressLine(address), '开发机 · dev@device-ts:2222')
  assert.equal(sameAddress(address, { ...address }), true)
  assert.equal(sameAddress(address, { ...address, port: 22 }), false)
})

test('倒计时、确认码', () => {
  assert.equal(countdown(600_000), '10:00')
  assert.equal(countdown(599_001), '10:00')
  assert.equal(countdown(59_000), '0:59')
  assert.equal(countdown(-5), '0:00')
  assert.equal(codeText('482913'), '482 913')
  assert.equal(codeText('12'), '12')
})

test('出码失败：认得的 key 照说，不认识的是 null；哪几种摆原话；没开 SSH 服务按系统说', () => {
  assert.equal(failureOf({ key: 'selfTest' }), 'selfTest')
  assert.equal(failureOf({ key: 'sshOff' }), 'sshOff')
  assert.equal(failureOf({ key: 'address' }), null)
  assert.equal(failureOf(null), null)
  assert.equal(showsSaid('selfTest'), true)
  assert.equal(showsSaid('sshOff'), false)
  assert.equal(showsSaid(null), true)
  assert.equal(sshOffHint('macos'), 'pairing.fail.sshOff.macos')
  assert.equal(sshOffHint(null), 'pairing.fail.sshOff.macos')
  assert.equal(sshOffHint('windows'), 'pairing.fail.sshOff.windows')
  assert.equal(sshOffHint('linux'), 'pairing.fail.sshOff.linux')
})

test('什么时候算作废、什么时候到点自动换码', () => {
  for (const state of ['done', 'expired', 'cancelled', 'rejected'])
    assert.equal(finalState(state), true)
  for (const state of ['waiting', 'requested']) assert.equal(finalState(state), false)
  assert.deepEqual(
    ['waiting', 'requested', 'done', 'expired', 'cancelled', 'rejected'].filter(refreshes),
    ['waiting', 'expired'],
  )
})

test('每一种失败、每一种状态两种语言都有话说', () => {
  for (const lang of ['zh-CN', 'en']) {
    const t = translator(lang)
    for (const key of [
      'keysFile',
      'noHostKey',
      'hostKeyMismatch',
      'selfTest',
      'sshOff',
      'unsupported',
      'offline',
    ]) {
      assert.notEqual(t(`pairing.fail.${key}`), `pairing.fail.${key}`)
    }
    for (const state of ['rejected', 'cancelled', 'expired']) {
      assert.notEqual(t(`pairing.state.${state}`), `pairing.state.${state}`)
    }
    assert.match(t('phones.count', { count: 2 }), /2/)
  }
})
