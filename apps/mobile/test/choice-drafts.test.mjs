// 手机作答选中的选项存成草稿（src/screens/managers/choice-drafts.ts）：离开再回来还在，各议题互不影响，
// 清掉只清自己；经理改掉了那个选项就当没选。
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { files } from 'expo-file-system'
import { readChoice, writeChoice } from '../src/screens/managers/choice-drafts.ts'

afterEach(() => files.clear())

const key = (id) => JSON.stringify(['local', 'm1', id])
const options = [{ id: 'a' }, { id: 'b' }]

test('选中的选项存进草稿，重新读回来还在', () => {
  assert.equal(readChoice(key('D-13'), options), null, '没选过')
  writeChoice(key('D-13'), 'b')
  assert.equal(readChoice(key('D-13'), options), 'b')
  writeChoice(key('D-13'), 'a')
  assert.equal(readChoice(key('D-13'), options), 'a', '改选覆盖')
})

test('各议题各存一份，清掉只清自己', () => {
  writeChoice(key('D-13'), 'b')
  writeChoice(key('D-15'), 'a')
  writeChoice(key('D-13'), null)
  assert.equal(readChoice(key('D-13'), options), null)
  assert.equal(readChoice(key('D-15'), options), 'a')
})

test('经理改掉了选项：存着的不再算选中', () => {
  writeChoice(key('D-13'), 'c')
  assert.equal(readChoice(key('D-13'), options), null)
})

test('文件坏了当没有草稿，之后照常写', () => {
  writeChoice(key('D-15'), 'a')
  for (const path of files.keys()) files.set(path, '{坏')
  assert.equal(readChoice(key('D-15'), options), null)
  writeChoice(key('D-13'), 'b')
  assert.equal(readChoice(key('D-13'), options), 'b')
})
