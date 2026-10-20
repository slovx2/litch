// 浏览器面板上“代理请你登录”的卡片：这个会话的有哪些、先出哪条。纯函数，单独测（test/passwords-logic.test.mjs）。
import { type BrowserOwner, type BrowserSignInRequest, ownerKey } from './bridge.ts'

/** 这个会话里的卡片：眼前这个标签的排最前，其余新的在前 */
export function signInsFor(
  requests: readonly BrowserSignInRequest[],
  owner: BrowserOwner,
  currentTabId: string | null,
): BrowserSignInRequest[] {
  const key = ownerKey(owner)
  return requests
    .filter((one) => ownerKey({ deviceId: one.deviceId, threadId: one.threadId }) === key)
    .sort(
      (a, b) => Number(b.tabId === currentTabId) - Number(a.tabId === currentTabId) || b.at - a.at,
    )
}
