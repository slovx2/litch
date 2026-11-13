import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileDestination, revealLabel } from '../src/files/destination.ts'
import { en } from '../src/i18n/en.ts'
import { zhCN } from '../src/i18n/zh-CN.ts'
import { mediaActionKey, mediaActions } from '../src/transcript/media/actions.ts'

const image = { url: 'blob:fictional', width: 80, height: 60 }
const file = { deviceId: 'atlas', root: '/work', path: '/work/diagram.png' }
const subject = (source) => ({ kind: 'image', source, label: '虚构图表', image })
const options = { copy: true, text: true, destination: null, enlarge: true }

test('本机与远程图片复用文件目的地规则，不显示不可用项', () => {
  const source = subject({ kind: 'file', file })
  assert.deepEqual(
    mediaActions(source, {
      ...options,
      destination: fileDestination('local', false, { reveal: true, save: true }),
    }),
    ['copy', 'revealLocal', 'copyPath', 'files', 'enlarge'],
  )
  assert.deepEqual(
    mediaActions(source, {
      ...options,
      destination: fileDestination('ssh', false, { reveal: true, save: true }),
    }),
    ['copy', 'save', 'copyPath', 'files', 'enlarge'],
  )
  assert.deepEqual(mediaActions(source, { ...options, copy: false, text: false }), [
    'files',
    'enlarge',
  ])
})

test('外网图片复制地址并走浏览器；灯箱不再提供查看大图', () => {
  const source = subject({ kind: 'url', href: 'https://atlas.example.invalid/diagram.png' })
  assert.deepEqual(mediaActions(source, options), [
    'copy',
    'save',
    'copyPath',
    'enlarge',
    'browser',
  ])
  assert.deepEqual(mediaActions(source, { ...options, enlarge: false }), [
    'copy',
    'save',
    'copyPath',
    'browser',
  ])
  assert.equal(mediaActionKey('copyPath', source.source), 'media.menu.copyAddress')
})

test('工具缓存图片没有文件操作，按需原图可复制保存；未加载原图不能复制', () => {
  const source = subject({ kind: 'tool' })
  assert.deepEqual(mediaActions(source, options), ['copy', 'save', 'enlarge'])
  assert.deepEqual(
    mediaActions({ ...source, image: undefined }, { ...options, enlarge: false }),
    [],
  )
  assert.deepEqual(mediaActions({ ...source, image: undefined, load() {} }, options), [
    'copy',
    'save',
    'enlarge',
  ])
})

test('各平台菜单文案与中英文资源完整', () => {
  assert.equal(revealLabel('darwin'), 'files.action.revealFinder')
  assert.equal(revealLabel('win32'), 'files.action.revealExplorer')
  assert.equal(revealLabel('linux'), 'files.action.revealManager')
  for (const source of [
    { kind: 'file', file },
    { kind: 'url', href: 'https://atlas.example.invalid/image' },
    { kind: 'tool' },
  ])
    for (const action of mediaActions(subject(source), options)) {
      const key = mediaActionKey(action, source)
      assert.ok(en[key])
      assert.ok(zhCN[key])
    }
})
