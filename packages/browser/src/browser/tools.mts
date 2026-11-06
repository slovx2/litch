// litch_browser 的全部工具，按名字查。名字和 packages/protocol/src/client-tools-browser.mts 里的定义一一对应。
import type { Tool } from './executor.mjs'
import { click, dialog, press, scroll, type, upload } from './tools-act.mjs'
import { consoleTool, evaluate, screenshot, snapshot, wait } from './tools-read.mjs'
import { requestSignIn } from './tools-signin.mjs'
import { navigate, show, tabs } from './tools-tabs.mjs'

export const TOOLS: Readonly<Record<string, Tool>> = {
  tabs,
  navigate,
  snapshot,
  click,
  type,
  press,
  scroll,
  screenshot,
  wait,
  console: consoleTool,
  evaluate,
  upload,
  dialog,
  request_sign_in: requestSignIn,
  show,
}
