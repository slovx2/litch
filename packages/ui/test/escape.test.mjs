// 两下 Esc 打断回合（src/composer/escape.ts）：第一下上膛、两秒内同一个回合里再按才停；
// 哪些 Esc 不归它（别处认了的、组字的、带修饰键的、按住重复的、模态框开着、在弹层菜单终端里、在别的输入控件里）；
// 两个输入区（主区域和侧面板的子代理页）时这一下归谁。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { ESC_WINDOW, escapeFree, escStep, ownerOf } = await import('../src/composer/escape.ts')

/**
 * 假的元素：只答 closest。kind 说它在什么里面：
 * composer 会话的输入框，input 别的输入框，dialog/menu/listbox/xterm 自己管 Esc 的一块，plain 普通的地方。
 * scope 是它所在的 [data-esc-scope]（没有就是 null）
 */
function el(kind, scope = null) {
  const node = {
    closest(selector) {
      if (selector === '[data-esc-scope]') return scope
      if (selector === 'textarea.cmp-text') return kind === 'composer' ? node : null
      const owner = {
        dialog: 'role="dialog"',
        menu: 'role="menu"',
        listbox: 'role="listbox"',
        xterm: '.xterm',
      }[kind]
      if (owner && selector.includes(owner)) return node
      if (selector.startsWith('input, textarea') && (kind === 'composer' || kind === 'input'))
        return node
      return null
    },
  }
  return node
}

const esc = (target, more = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  isComposing: false,
  keyCode: 27,
  repeat: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  target,
  ...more,
})

test('第一下上膛，两秒内同一个回合再按才停', () => {
  assert.equal(escStep(null, 't1', 1000), 'arm')
  const arm = { turnId: 't1', at: 1000 }
  assert.equal(escStep(arm, 't1', 1000 + 300), 'stop')
  assert.equal(escStep(arm, 't1', 1000 + ESC_WINDOW), 'stop')
  // 过了时候：重新上膛
  assert.equal(escStep(arm, 't1', 1000 + ESC_WINDOW + 1), 'arm')
  // 回合换了：上一个回合里按的那一下不算
  assert.equal(escStep(arm, 't2', 1200), 'arm')
  assert.equal(ESC_WINDOW, 2000)
})

test('输入框里有没有字、焦点在不在输入框都算', () => {
  assert.equal(escapeFree(esc(el('composer')), false), true)
  // 焦点在对话区、侧栏的某一行，或者落在 body 上
  assert.equal(escapeFree(esc(el('plain')), false), true)
  assert.equal(escapeFree(esc(null), false), true)
})

test('别处认了的、组字的、带修饰键的、按住重复的不算', () => {
  const target = el('composer')
  assert.equal(escapeFree(esc(target, { defaultPrevented: true }), false), false)
  assert.equal(escapeFree(esc(target, { isComposing: true }), false), false)
  assert.equal(escapeFree(esc(target, { keyCode: 229 }), false), false)
  assert.equal(escapeFree(esc(target, { repeat: true }), false), false)
  for (const key of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey']) {
    assert.equal(escapeFree(esc(target, { [key]: true }), false), false, key)
  }
  assert.equal(escapeFree(esc(target, { key: 'Enter' }), false), false)
})

test('模态框开着、在弹层菜单单子终端里、在别的输入框里都不算', () => {
  assert.equal(escapeFree(esc(el('plain')), true), false)
  for (const kind of ['dialog', 'menu', 'listbox', 'xterm', 'input']) {
    assert.equal(escapeFree(esc(el(kind)), false), false, kind)
  }
})

test('两个输入区：子代理页里的归子代理，别处的归主区域', () => {
  const side = el('plain')
  const main = { name: 'main', input: el('composer') }
  const agent = { name: 'agent', input: el('composer', side) }
  const both = [agent, main]
  assert.equal(ownerOf(both, el('plain', side))?.name, 'agent')
  assert.equal(ownerOf(both, el('composer', side))?.name, 'agent')
  assert.equal(ownerOf(both, el('plain'))?.name, 'main')
  assert.equal(ownerOf(both, null)?.name, 'main')
  // 主区域没有在跑的回合（没登记）：别处按的不会落到子代理头上
  assert.equal(ownerOf([agent], el('plain')), null)
  // 子代理页里按，可子代理没在跑：也不落到主区域
  assert.equal(ownerOf([main], el('plain', side)), null)
})
