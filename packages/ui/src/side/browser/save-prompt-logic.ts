// 浏览器面板上的保存提示：这个会话的有哪些、先出哪条。纯函数，单独测（test/passwords-logic.test.mjs）。
import { type BrowserOwner, type BrowserSavePrompt, ownerKey } from './bridge.ts'

/** 这个会话里的保存提示，新的在前 */
export function promptsFor(
  prompts: readonly BrowserSavePrompt[],
  owner: BrowserOwner,
): BrowserSavePrompt[] {
  const key = ownerKey(owner)
  return prompts
    .filter((one) => ownerKey({ deviceId: one.deviceId, threadId: one.threadId }) === key)
    .sort((a, b) => b.at - a.at)
}
