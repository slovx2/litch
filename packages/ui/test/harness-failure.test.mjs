import assert from 'node:assert/strict'
import test from 'node:test'
import { harnessFailureText } from '../src/devices/harness-failure.ts'
import { translator } from '../src/i18n/index.ts'

const harness = {
  state: 'unavailable',
  reason: '启动失败',
  detail: {
    'zh-CN': '引擎启动失败：socket directory is not private to the current user',
    en: 'The engine failed to start: socket directory is not private to the current user',
  },
}
test('两端列表的不可用摘要保留设备具体原因，中英文均可读；就绪或停用不显示旧失败', () => {
  for (const lang of ['zh-CN', 'en']) {
    const t = translator(lang)
    assert.match(harnessFailureText(harness, t), /socket directory is not private/)
    assert.equal(harnessFailureText({ ...harness, state: 'ready' }, t), null)
    assert.equal(harnessFailureText({ ...harness, state: 'disabled' }, t), null)
    assert.equal(
      harnessFailureText(
        { ...harness, reason: '相同原因', detail: { 'zh-CN': '相同原因', en: '相同原因' } },
        t,
      ),
      '相同原因',
    )
  }
})
