// 本机整理文件（src/organizer-store.mts）：写入留备份、坏了用备份并保留原件、没有备份时报坏、版本更高不碰
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { emptyOrganizer, type OrganizerFile } from '@litch/core'
import { fileOrganizerStore, ORGANIZER_FILE } from '../organizer-store.mjs'

const file = (revision: number, name = '发布'): OrganizerFile => ({
  ...emptyOrganizer(),
  revision,
  groups: [{ id: 'g', name, members: [{ kind: 'session', deviceId: 'mac', sessionId: 's' }] }],
})

test('没有文件是空的；写两次后备份是上一份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-organizer-'))
  const store = fileOrganizerStore(dir)
  assert.deepEqual(store.load(), { kind: 'empty' })
  store.save(file(1))
  store.save(file(2))
  assert.deepEqual(store.load(), { kind: 'ok', file: file(2) })
  const backup = JSON.parse(readFileSync(join(dir, `${ORGANIZER_FILE}.bak`), 'utf8'))
  assert.equal(backup.revision, 1)
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test('主文件坏了：挪到一边保留原件，用最后一份有效的备份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-organizer-'))
  const store = fileOrganizerStore(dir, () => 42)
  store.save(file(1))
  store.save(file(2))
  writeFileSync(join(dir, ORGANIZER_FILE), '{半个文件')
  assert.deepEqual(store.load(), { kind: 'ok', file: file(1) })
  assert.equal(readFileSync(join(dir, 'sidebar-organizer.corrupt-42.json'), 'utf8'), '{半个文件')
})

test('没有可用的备份时报坏，不悄悄当成空的写回；版本更高的不碰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-organizer-'))
  writeFileSync(join(dir, ORGANIZER_FILE), 'not json')
  assert.deepEqual(fileOrganizerStore(dir).load(), { kind: 'corrupt' })
  assert.ok(existsSync(join(dir, ORGANIZER_FILE)))
  writeFileSync(join(dir, ORGANIZER_FILE), JSON.stringify({ version: 7 }))
  writeFileSync(join(dir, `${ORGANIZER_FILE}.bak`), JSON.stringify(file(1)))
  assert.deepEqual(fileOrganizerStore(dir).load(), { kind: 'newer', version: 7 })
})
