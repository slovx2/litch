// 把模型给的按键（"Enter"、"Control+A"、"Meta+Shift+K"）换成 CDP 的 Input.dispatchKeyEvent 参数。纯函数。

/** CDP 的修饰键位：Alt 1、Control 2、Meta 4、Shift 8 */
const MODIFIERS: Record<string, number> = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
}

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
}

/** macOS 上 Cmd 加这几个字母不会自己变成编辑命令，要明着告诉页面引擎 */
const MAC_COMMANDS: Record<string, string> = {
  a: 'selectAll',
  c: 'copy',
  v: 'paste',
  x: 'cut',
  z: 'undo',
}

/** 一次按键：先按下（keyDown 或 rawKeyDown）再抬起，参数里除了 type 都一样 */
export interface KeyPress {
  down: Record<string, unknown>
  up: Record<string, unknown>
}

function single(name: string): KeyDef | null {
  const lower = name.toLowerCase()
  const named = NAMED[lower]
  if (named) return named
  const fn = /^f([1-9]|1[0-2])$/.exec(lower)
  if (fn) {
    const n = Number(fn[1])
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n }
  }
  if ([...name].length !== 1) return null
  if (/^[a-z]$/i.test(name)) {
    const upper = name.toUpperCase()
    return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name }
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name }
  }
  // 别的单个字符（标点、汉字）：没有固定的键位，只带字
  return { key: name, code: '', keyCode: 0, text: name }
}

/** 解析一个按键组合；认不出是 null */
export function parseKey(combo: string): KeyPress | null {
  const parts = combo.split('+').map((part) => part.trim())
  // "Control++" 这种：最后一段是加号本身
  if (combo.endsWith('++')) parts.splice(parts.length - 2, 2, '+')
  const last = parts.pop()
  if (!last) return null
  let modifiers = 0
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()]
    if (bit === undefined) return null
    modifiers |= bit
  }
  const def = single(last)
  if (!def) return null
  const shift = (modifiers & 8) !== 0
  // 带 Control、Alt、Meta 的组合不打出字；只带 Shift 的字母打大写
  const typing = (modifiers & ~8) === 0 && def.text !== undefined
  const text = typing
    ? shift && /^[a-z]$/.test(def.text ?? '')
      ? def.key.toUpperCase()
      : def.text
    : undefined
  const base: Record<string, unknown> = {
    key: shift && /^[a-z]$/.test(def.key) ? def.key.toUpperCase() : def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    modifiers,
  }
  const command = (modifiers & 4) !== 0 ? MAC_COMMANDS[def.key.toLowerCase()] : undefined
  return {
    down: {
      ...base,
      type: text !== undefined ? 'keyDown' : 'rawKeyDown',
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
      ...(command ? { commands: [command] } : {}),
    },
    up: { ...base, type: 'keyUp' },
  }
}
