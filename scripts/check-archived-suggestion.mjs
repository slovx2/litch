// 由 check-local-workspace-ui.mjs --archived-suggestion 驱动，不连接真实经理。
import assert from 'node:assert/strict'

export async function verifyArchivedSuggestion({ call, base, run, click, exists, shot, until }) {
  for (const device of ['local', 'build']) {
    for (const lang of ['zh-CN', 'en']) {
      await call('Page.navigate', {
        url: `${base}/test/archived-suggestion-fixture.html?device=${device}&lang=${lang}`,
      })
      const card = '[data-post-card="S-archived-model"]'
      await until(() => exists(card), '经理建议卡')
      if (await exists(`${card}[data-post-collapsed=true]`))
        await click(`${card} [data-act=post-collapse]`)
      await until(() => exists(`${card} [data-act=start]:not(:disabled)`), '归档来源的开始按钮')
      const label = lang === 'en' ? 'Source archived' : '来源已归档'
      assert.ok(await run((label) => document.body.innerText.includes(label), label))
      await shot(`archived-suggestion-${device}-${lang}.png`)
      await click(`${card} [data-act=start]`)
      await until(() => run(() => archivedSuggestionFixture.calls.length === 1), '直接开始请求')
      const params = await run(() => archivedSuggestionFixture.calls[0])
      assert.equal(params.deviceId, device)
      assert.equal(params.sessionId, 'archived-source')
      assert.equal(params.proposalId, 'archived-model')
      assert.equal(params.overrides?.modelSelected, undefined, '无须先编辑具体型号')
    }
  }
}
