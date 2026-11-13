// 由隔离 CFT 主脚本调用；正式 App 的查看计时、目录更新、最近投影与侧栏绘制都保留。
import assert from 'node:assert/strict'

export async function verifyPinnedRecent({ call, base, run, click, exists, shot, until }) {
  await call('Page.navigate', {
    url: `${base}/test/local-workspace-fixture.html?lang=zh-CN&recent=1&onboarding=off`,
  })
  const pinned = '[data-shortcuts="pins"]'
  const recent = '[data-projection="recent"]'
  const unread = '[data-projection="unread"]'
  await until(() => exists(`${pinned} [data-session="p1"]`), '置顶会话')
  assert.equal(await exists(`${recent} [data-session="p1"]`), false)
  await click(`${pinned} [data-session="p1"] .ss-row`)
  await until(() => exists(`${recent} [data-session="p1"]`), '查看置顶会话后进入最近')
  const command = (name, params) =>
    run((n, p) => window.__localWorkspace.channel.command(n, p), name, params)
  await command('workspace.update', { deviceId: 'local', workspaceId: 'litch', pinned: true })
  await until(() => exists(`${pinned} [data-workspace="litch"]`), '置顶项目')
  await command('session.rename', {
    deviceId: 'local',
    sessionId: 's2',
    title: '聚合面：会话列表合并与复合游标',
  })
  await until(() => exists(`${recent} [data-session="s2"]`), '置顶项目内会话进入最近')
  assert.equal(await exists(`${unread} [data-session="s2"]`), false)
  for (const id of ['p1', 's2'])
    assert.equal(
      await run(
        (selector) => document.querySelectorAll(selector).length,
        `${recent} [data-session="${id}"]`,
      ),
      1,
    )
  for (const groupId of ['one', 'two'])
    await command('organizer.apply', { action: { type: 'group.delete', groupId } })
  await run(() => window.__litchLook.set({ skin: 'standard', theme: 'light', lang: 'zh-CN' }))
  await run(() => {
    document.querySelector('.sb-scroll').scrollTop = 0
  })
  await shot('desktop-pinned-and-recent.png')
}
