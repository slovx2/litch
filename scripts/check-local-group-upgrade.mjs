// 用首版客户端的原始 parser/host/两端存储实测升级与降级，不能用新 parser 假扮旧客户端。
// node --import tsx scripts/check-local-group-upgrade.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOrganizerHost, emptyOrganizer, parseOrganizer } from '../packages/core/src/index.mts'

const repo = fileURLToPath(new URL('..', import.meta.url))
const coreUrl = new URL('../packages/core/src/index.mts', import.meta.url).href
const old = (path) =>
  execFileSync('git', ['-C', repo, 'show', `755dc625:${path}`], { encoding: 'utf8' })
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`
const fileUrl = moduleUrl(old('packages/core/src/organizer/file.mts'))
const actionsUrl = moduleUrl(
  old('packages/core/src/organizer/actions.mts').replaceAll(
    "'./file.mjs'",
    JSON.stringify(fileUrl),
  ),
)
const protocolUrl = new URL('../packages/core/src/channel/protocol.mts', import.meta.url).href
const phraseUrl = new URL('../packages/core/src/phrase.mts', import.meta.url).href
const hostUrl = moduleUrl(
  old('packages/core/src/organizer/host.mts')
    .replaceAll("'./file.mjs'", JSON.stringify(fileUrl))
    .replaceAll("'./actions.mjs'", JSON.stringify(actionsUrl))
    .replaceAll("'../channel/protocol.mjs'", JSON.stringify(protocolUrl))
    .replaceAll("'../phrase.mjs'", JSON.stringify(phraseUrl)),
)
const oldFile = await import(fileUrl)
const oldHost = await import(hostUrl)
const oldDesktop = await import(
  moduleUrl(
    old('apps/desktop/src/organizer-store.mts').replaceAll(
      "'@litch/core'",
      JSON.stringify(fileUrl),
    ),
  )
)
const oldMobile = await import(
  moduleUrl(
    old('apps/mobile/src/shell/organizer-slots.ts').replaceAll(
      "'@litch/core'",
      JSON.stringify(fileUrl),
    ),
  )
)
const currentModule = (path) =>
  import(
    moduleUrl(
      readFileSync(join(repo, path), 'utf8').replaceAll("'@litch/core'", JSON.stringify(coreUrl)),
    )
  )
const { fileOrganizerStore } = await currentModule('apps/desktop/src/organizer-store.mts')
const { slottedOrganizerStore } = await currentModule('apps/mobile/src/shell/organizer-slots.ts')
const legacy = {
  version: 1,
  revision: 4,
  groups: [{ id: 'g', name: '保留的分组', members: [{ deviceId: 'mac', sessionId: 's' }] }],
  pinOrder: [],
  folds: { g: true },
}
const modern = {
  ...emptyOrganizer(),
  revision: 5,
  groups: [
    {
      id: 'g',
      name: '保留的分组',
      members: [
        { kind: 'session', deviceId: 'mac', sessionId: 's' },
        { kind: 'workspace', deviceId: 'mac', workspaceId: 'w' },
      ],
    },
  ],
  folds: { g: true },
}
const area = mkdtempSync(join(tmpdir(), 'litch-organizer-upgrade-'))
const desktopDir = join(area, 'desktop')
mkdirSync(desktopDir)
const main = join(desktopDir, 'sidebar-organizer.json')
const backup = `${main}.bak`
writeFileSync(main, JSON.stringify(legacy))
const upgraded = createOrganizerHost(fileOrganizerStore(desktopDir), () => 1)
assert.equal(upgraded.view().groups[0].members[0].kind, 'session')
upgraded.apply({ type: 'member.add', groupId: 'g', member: modern.groups[0].members[1] })
assert.deepEqual(JSON.parse(readFileSync(main, 'utf8')), modern)
assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), legacy)

const checkBlocked = (store) => {
  assert.deepEqual(store.load(), { kind: 'newer', version: 2 })
  const host = oldHost.createOrganizerHost(store, () => 1)
  assert.equal(host.view().status, 'newer')
  assert.throws(() => host.apply({ type: 'group.create', name: '禁止覆盖' }))
  assert.throws(() => host.apply({ type: 'fold', key: 'g', closed: false }))
}
const before = readFileSync(main, 'utf8')
checkBlocked(oldDesktop.fileOrganizerStore(desktopDir))
assert.equal(readFileSync(main, 'utf8'), before)
assert.deepEqual(JSON.parse(readFileSync(backup, 'utf8')), legacy, '旧桌面不恢复旧备份')

for (const modernSlot of ['a', 'b']) {
  const slots = new Map([
    [modernSlot, JSON.stringify(modern)],
    [modernSlot === 'a' ? 'b' : 'a', JSON.stringify(legacy)],
  ])
  const initial = new Map(slots)
  const io = {
    read: (slot) => slots.get(slot) ?? null,
    write: (slot, text) => slots.set(slot, text),
  }
  checkBlocked(oldMobile.slottedOrganizerStore(io))
  assert.deepEqual(slots, initial, '旧手机不回退旧格、不覆盖新文件')
  assert.equal(slottedOrganizerStore(io).load().file.revision, 5)
}
assert.deepEqual(oldFile.parseOrganizer(modern), { kind: 'newer', version: 2 })
assert.equal(oldFile.parseOrganizer({ ...modern, version: 1 }).kind, 'corrupt')
assert.equal(parseOrganizer(legacy).kind, 'ok')
console.log(
  JSON.stringify(
    {
      success: true,
      baseline: '755dc625',
      desktop: 'v1 迁移保留旧备份，旧客户端停写',
      mobile: '两格任一含 v2，旧客户端均停写',
      area,
    },
    null,
    2,
  ),
)
