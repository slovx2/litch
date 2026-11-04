import type { ClientToolNamespaceSpec } from './client-tools.mjs'
import { computerToolsSpec } from './client-tools-computer.mjs'

/**
 * 手机上或设备后台建会话时，不知道下一次执行工具的是哪台桌面。
 * 两个平台使用相同工具名；Windows 的 schema 多一个可选 window，保留它即可兼顾两端。
 * 用法分别标明平台，要求以实际 list_apps / get_app_state 返回的标识为准。
 */
export function portableComputerTools(): ClientToolNamespaceSpec {
  const mac = computerToolsSpec('darwin', true)
  const windows = computerToolsSpec('win32', true)
  return {
    ...windows,
    description:
      'Control apps on a connected Litch desktop (macOS or Windows). The desktop may differ from the session host. Call list_apps first and use its app identifiers; inspect get_app_state before acting. On Windows use window numbers from observations; omit window on macOS. Observing or controlling the installed release of Litch itself requires user approval; never bypass a refusal. If no desktop is connected, ask the user to open Litch desktop and connect this device before retrying.',
    tools: windows.tools.map((tool) => {
      const other = mac.tools.find((entry) => entry.name === tool.name)
      return other && other.description !== tool.description
        ? { ...tool, description: `macOS: ${other.description}\nWindows: ${tool.description}` }
        : tool
    }),
  }
}
