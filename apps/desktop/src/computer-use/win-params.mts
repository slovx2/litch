// Windows 上七个动作的参数换算（纯函数，单独测）：工具参数 → 助手的方法和参数（09 号 9.2），外加给模型的一句做了什么。
//   - element 编号 → 助手认的 ref（最近一次取状态或动作后差异里的那一行）。
//   - x / y → 原样（截图像素），带上最近一次截图的截图号，先查在不在截图里。
//   - drag 的 from_element / to_element → 元素中心的截图坐标（元素的 frame 是截图像素）。
//   - modifiers（"ctrl+shift"）→ 数组；press_key 的 "ctrl+s" → key 和 modifiers。cmd 原样交给助手（它映射成 ctrl），
//     Windows 键这边先拒（助手也拒）。
// 参数不对时抛 HelperError('invalid')，执行器转成给模型的 invalid 答复。
import { COMPUTER_TOOL } from '../../../../packages/protocol/src/client-tools-computer.mjs'
import type { AXLine } from './ax-text.mjs'
import { HelperError } from './wire.mjs'

/** 最近一次截图：截图号和大小 */
export interface WinShot {
  id: string | number
  width: number
  height: number
}

/** 换算要的状态：最近的行、最近的截图 */
export interface WinParamState {
  lines: ReadonlyMap<number, AXLine>
  shot: WinShot | null
}

export interface WinAction {
  method: string
  params: Record<string, unknown>
  summary: string
}

/** Windows 键的各种叫法 */
const WINDOWS_KEYS = new Set(['win', 'windows', 'super', 'meta', 'lwin', 'rwin', 'start'])

const invalid = (message: string): HelperError => new HelperError('invalid', message)

function line(state: WinParamState, value: unknown, name: string): AXLine {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw invalid(`${name} must be an element number from get_app_state.`)
  }
  const found = state.lines.get(value as number)
  if (!found) {
    throw invalid(
      `Element [${value}] is not in the latest state of this app. Call get_app_state and use a current number.`,
    )
  }
  return found
}

function shotOf(state: WinParamState): WinShot {
  if (!state.shot) throw invalid('No screenshot of this app yet. Call get_app_state first.')
  return state.shot
}

/** 截图上的一点：查是不是数、在不在截图里 */
function point(state: WinParamState, x: unknown, y: unknown): { x: number; y: number } {
  const shot = shotOf(state)
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    throw invalid('x and y must be numbers.')
  }
  if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) {
    throw invalid(
      `(${Math.round(x)}, ${Math.round(y)}) is outside the screenshot, which is ${shot.width}x${shot.height} pixels.`,
    )
  }
  return { x, y }
}

/** 元素中心在截图上的点 */
function center(found: AXLine): { x: number; y: number } {
  const frame = found.frame
  if (!frame || frame.width <= 0 || frame.height <= 0) {
    throw invalid(`Element [${found.index}] has no position on screen; use coordinates instead.`)
  }
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
}

/** "ctrl+shift" → ["ctrl", "shift"]；拒绝 Windows 键 */
export function parseModifiers(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return []
  if (typeof value !== 'string') throw invalid('modifiers must be a string like "ctrl+shift".')
  const keys = value
    .split('+')
    .map((one) => one.trim().toLowerCase())
    .filter((one) => one !== '')
  for (const key of keys) {
    if (WINDOWS_KEYS.has(key)) throw invalid('The Windows key is not allowed.')
  }
  return keys
}

/** "ctrl+shift+t" → {key: "t", modifiers: ["ctrl", "shift"]}；"ctrl++" 的键是 "+" */
export function parseKey(value: unknown): { key: string; modifiers: string[] } {
  if (typeof value !== 'string' || value.trim() === '') throw invalid('key is required.')
  const raw = value.trim()
  let key: string
  let rest: string
  if (raw === '+' || raw.endsWith('++')) {
    key = '+'
    rest = raw.slice(0, -1)
  } else {
    const at = raw.lastIndexOf('+')
    key = raw.slice(at + 1).trim()
    rest = at >= 0 ? raw.slice(0, at) : ''
  }
  if (key === '') throw invalid(`"${raw}" has no key after the modifiers.`)
  if (WINDOWS_KEYS.has(key.toLowerCase())) throw invalid('The Windows key is not allowed.')
  return { key, modifiers: parseModifiers(rest) }
}

function count(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw invalid(`${name} must be a whole number from ${min} to ${max}.`)
  }
  return value as number
}

const chars = (value: string): number => [...value].length

/** 一次动作的工具参数 → 助手的方法、参数和给模型的一句话 */
export function winActionParams(
  tool: string,
  params: Record<string, unknown>,
  state: WinParamState,
): WinAction {
  switch (tool) {
    case COMPUTER_TOOL.click: {
      const button = params.button ?? 'left'
      if (button !== 'left' && button !== 'right' && button !== 'middle') {
        throw invalid('button must be left, right or middle.')
      }
      const times = count(params.count, 'count', 1, 3) ?? 1
      const modifiers = parseModifiers(params.modifiers)
      const how = `(${button}, ${times}x)`
      const common = { button, count: times, ...(modifiers.length > 0 ? { modifiers } : {}) }
      if (params.element !== undefined) {
        const found = line(state, params.element, 'element')
        return {
          method: 'click',
          params: { ref: found.ref, ...common },
          summary: `Clicked [${found.index}] ${found.content} ${how}.`,
        }
      }
      if (params.x === undefined || params.y === undefined) {
        throw invalid('Give either element or both x and y.')
      }
      const at = point(state, params.x, params.y)
      return {
        method: 'click',
        params: { screenshotId: shotOf(state).id, ...at, ...common },
        summary: `Clicked (${Math.round(at.x)}, ${Math.round(at.y)}) ${how}.`,
      }
    }
    case COMPUTER_TOOL.typeText: {
      if (typeof params.text !== 'string') throw invalid('text is required.')
      const ref =
        params.element !== undefined ? line(state, params.element, 'element').ref : undefined
      return {
        method: 'typeText',
        params: { text: params.text, ...(ref ? { ref } : {}) },
        summary: `Typed ${chars(params.text)} characters.`,
      }
    }
    case COMPUTER_TOOL.pressKey: {
      const { key, modifiers } = parseKey(params.key)
      const repeat = count(params.repeat, 'repeat', 1, 50)
      const shown = [...modifiers, key].join('+')
      return {
        method: 'pressKey',
        params: {
          key,
          ...(modifiers.length > 0 ? { modifiers } : {}),
          ...(repeat !== undefined ? { repeat } : {}),
        },
        summary: `Pressed ${shown}${repeat && repeat > 1 ? ` ${repeat} times` : ''}.`,
      }
    }
    case COMPUTER_TOOL.scroll: {
      const direction = params.direction
      if (
        direction !== 'up' &&
        direction !== 'down' &&
        direction !== 'left' &&
        direction !== 'right'
      ) {
        throw invalid('direction must be up, down, left or right.')
      }
      const amount = count(params.amount, 'amount', 1, 50) ?? 5
      let where: Record<string, unknown> = {}
      if (params.element !== undefined) {
        where = { ref: line(state, params.element, 'element').ref }
      } else if (params.x !== undefined || params.y !== undefined) {
        where = { screenshotId: shotOf(state).id, ...point(state, params.x, params.y) }
      }
      return {
        method: 'scroll',
        params: { direction, amount, ...where },
        summary: `Scrolled ${direction} by ${amount}.`,
      }
    }
    case COMPUTER_TOOL.setValue: {
      const found = line(state, params.element, 'element')
      if (typeof params.value !== 'string') throw invalid('value is required.')
      return {
        method: 'setValue',
        params: { ref: found.ref, value: params.value },
        summary: `Set the value of [${found.index}] ${found.content}.`,
      }
    }
    case COMPUTER_TOOL.drag: {
      const end = (prefix: 'from' | 'to') => {
        const element = params[`${prefix}_element`]
        if (element !== undefined) return center(line(state, element, `${prefix}_element`))
        const x = params[`${prefix}_x`]
        const y = params[`${prefix}_y`]
        if (x === undefined || y === undefined) {
          throw invalid(`Give either ${prefix}_element or both ${prefix}_x and ${prefix}_y.`)
        }
        return point(state, x, y)
      }
      const from = end('from')
      const to = end('to')
      return {
        method: 'drag',
        params: { screenshotId: shotOf(state).id, from, to },
        summary: 'Dragged.',
      }
    }
    case COMPUTER_TOOL.selectText: {
      const found = line(state, params.element, 'element')
      if (params.text !== undefined && typeof params.text !== 'string') {
        throw invalid('text must be a string.')
      }
      const start = count(params.start, 'start', 0, Number.MAX_SAFE_INTEGER)
      const length = count(params.length, 'length', 0, Number.MAX_SAFE_INTEGER)
      if (params.text === undefined && (start === undefined || length === undefined)) {
        throw invalid('Give either text, or both start and length.')
      }
      const size = typeof params.text === 'string' ? params.text.length : length
      return {
        method: 'selectText',
        params: {
          ref: found.ref,
          ...(typeof params.text === 'string' ? { text: params.text } : {}),
          ...(start !== undefined ? { start } : {}),
          ...(length !== undefined ? { length } : {}),
        },
        summary: `Selected ${size} characters in [${found.index}].`,
      }
    }
    default:
      throw invalid(`Unknown tool ${tool} in litch_computer.`)
  }
}
