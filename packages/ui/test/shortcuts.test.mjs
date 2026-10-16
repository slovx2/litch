// 快捷键清单（src/settings/shortcuts.ts）和代码对不对得上：清单里每一条都写了出处——哪个文件、那里搜得到的一段原文。
// 键被改了、挪了、删了，这里会指出是哪一条，改代码的人回去把清单一起改掉。
// 应用菜单那一头（菜单里带键的每一项清单里都有、键位一样）由设置页的验收拿真的菜单来对，不在这里。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { platformOf } from '../src/app/platform.ts'
import {
  canonical,
  capsOf,
  combosOn,
  SHORTCUT_GROUPS,
  SHORTCUTS,
} from '../src/settings/shortcuts.ts'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const PLATFORMS = ['mac', 'win', 'linux']

test('清单里每一条的出处都还在代码里', () => {
  const files = new Map()
  const read = (file) => {
    if (!files.has(file)) files.set(file, readFileSync(`${repo}${file}`, 'utf8'))
    return files.get(file)
  }
  const gone = []
  for (const shortcut of SHORTCUTS) {
    assert.ok(shortcut.source.length > 0, `${shortcut.id} 没写出处`)
    for (const { file, has } of shortcut.source) {
      if (!read(file).includes(has)) gone.push(`${shortcut.id}：${file} 里找不到「${has}」`)
    }
  }
  assert.deepEqual(gone, [])
})

test('清单本身是齐的：标识不重复、分组认得、每种系统上的按法写得出来', () => {
  const ids = SHORTCUTS.map((shortcut) => shortcut.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const shortcut of SHORTCUTS) {
    assert.ok(SHORTCUT_GROUPS.includes(shortcut.group), `${shortcut.id} 的分组不认识`)
    // 至少在一种系统上有键
    assert.ok(PLATFORMS.some((platform) => combosOn(shortcut, platform).length > 0))
    for (const platform of PLATFORMS) {
      for (const combo of combosOn(shortcut, platform)) {
        const caps = capsOf(combo, platform)
        assert.ok(caps.length > 0 && caps.every(Boolean), `${shortcut.id} 的 ${combo} 拆不开`)
        // “主修饰键”只该出现在各系统通用的写法里：分系统写的那几条要写明是 Cmd 还是 Ctrl
        if (!Array.isArray(shortcut.keys)) assert.ok(!combo.includes('Mod'), shortcut.id)
      }
    }
  }
})

test('同一个范围里，一种按法不会登记给两件事', () => {
  // 应用和编辑这两组在哪儿都管用，合在一起看；别的组各在各的范围里
  const scope = (group) => (group === 'edit' ? 'app' : group)
  for (const platform of PLATFORMS) {
    const taken = new Map()
    for (const shortcut of SHORTCUTS) {
      if (shortcut.group !== 'app' && shortcut.group !== 'edit') continue
      for (const combo of combosOn(shortcut, platform)) {
        const key = `${scope(shortcut.group)} ${canonical(combo, platform)}`
        assert.ok(
          !taken.has(key),
          `${platform}：${combo} 同时是 ${taken.get(key)} 和 ${shortcut.id}`,
        )
        taken.set(key, shortcut.id)
      }
    }
  }
})

test('键位换成能比的样子：菜单的写法和清单的写法落到同一处', () => {
  assert.equal(canonical('CmdOrCtrl+Alt+B', 'mac'), canonical('Mod+Alt+B', 'mac'))
  assert.equal(canonical('CmdOrCtrl+Alt+B', 'linux'), 'alt+ctrl+b')
  assert.equal(canonical('Control+Command+F', 'mac'), canonical('Ctrl+Cmd+F', 'mac'))
  assert.equal(canonical('Shift+CommandOrControl+Z', 'mac'), canonical('Shift+Cmd+Z', 'mac'))
  assert.equal(canonical('CmdOrCtrl+Plus', 'mac'), canonical('Mod+Plus', 'mac'))
  assert.equal(canonical('Ctrl+`', 'mac'), 'ctrl+`')
  assert.deepEqual(capsOf('Mod+Alt+B', 'mac'), ['Cmd', 'Option', 'B'])
  assert.deepEqual(capsOf('Mod+Alt+B', 'win'), ['Ctrl', 'Alt', 'B'])
  assert.deepEqual(capsOf('Mod+Plus', 'linux'), ['Ctrl', '+'])
})

test('认系统：外壳给的叫法和浏览器给的叫法都认得', () => {
  // darwin 这个词里也有 win 三个字母，不能认成 Windows
  assert.equal(platformOf('darwin'), 'mac')
  assert.equal(platformOf('MacIntel'), 'mac')
  assert.equal(platformOf('win32'), 'win')
  assert.equal(platformOf('Win32'), 'win')
  assert.equal(platformOf('linux'), 'linux')
  assert.equal(platformOf('Linux x86_64'), 'linux')
})
