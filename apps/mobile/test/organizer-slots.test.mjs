// 手机本机整理文件的两格副本：交替写、挑最高的有效版本、写到一半坏了用另一格、更高版本不碰
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyOrganizer } from '@litch/core'
import { slottedOrganizerStore } from '../src/shell/organizer-slots.ts'

const io = () => {
  const slots = new Map()
  return {
    slots,
    read: (slot) => slots.get(slot) ?? null,
    write(slot, text) {
      slots.set(slot, text)
    },
  }
}
const file = (revision) => ({ ...emptyOrganizer(), revision })

test('交替写两格；重启后挑版本号最高的', () => {
  const disk = io()
  const store = slottedOrganizerStore(disk)
  assert.deepEqual(store.load(), { kind: 'empty' })
  store.save(file(1))
  store.save(file(2))
  store.save(file(3))
  assert.equal(JSON.parse(disk.slots.get('a')).revision, 3)
  assert.equal(JSON.parse(disk.slots.get('b')).revision, 2)
  assert.equal(slottedOrganizerStore(disk).load().file.revision, 3)
})

test('写到一半被杀：坏的那一格不算，用另一格；下次写回坏的那一格', () => {
  const disk = io()
  const store = slottedOrganizerStore(disk)
  store.load()
  store.save(file(1))
  store.save(file(2))
  disk.slots.set('b', '{"version":1,"rev')
  const again = slottedOrganizerStore(disk)
  assert.equal(again.load().file.revision, 1)
  again.save(file(2))
  assert.equal(JSON.parse(disk.slots.get('b')).revision, 2, '有效的那一格留着')
  assert.equal(JSON.parse(disk.slots.get('a')).revision, 1)
})

test('两格都坏报坏；有更高版本的停用', () => {
  const disk = io()
  disk.slots.set('a', 'x')
  assert.deepEqual(slottedOrganizerStore(disk).load(), { kind: 'corrupt' })
  disk.slots.set('b', JSON.stringify({ version: 5 }))
  assert.deepEqual(slottedOrganizerStore(disk).load(), { kind: 'newer', version: 5 })
})
