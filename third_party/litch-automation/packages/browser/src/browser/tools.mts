// 浏览器工具按名字查；定义来自 automation-contracts 的唯一源。
import type { Tool } from './executor.mjs'
import { click, dialog, press, scroll, type, upload } from './tools-act.mjs'
import { consoleTool, evaluate, screenshot, snapshot, wait } from './tools-read.mjs'
import { requestSignIn } from './tools-signin.mjs'
import { navigate, show, tabs } from './tools-tabs.mjs'

export const TOOLS: Readonly<Record<string, Tool>> = {
  downloads: async (call) =>
    call.done(
      null,
      'Download status follows. Pending files require individual user approval; do not retry a download.',
    ),
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
