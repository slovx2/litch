// 预加载脚本里给界面的内置浏览器接口（挂在 window.litchBrowser 上，和 litchShell 分开）。
// 界面只能经它报矩形、开关标签、导航；拿不到视图本身，也拿不到 Electron 的事件对象。
// 类型在界面那边另有一份（packages/ui/src/side/browser/bridge.ts），改一边要改另一边。
import { ipcRenderer } from 'electron'
import { importBridge } from '../browser-import/bridge.mjs'
import {
  BROWSER_BLOCK,
  BROWSER_CLEAR_DATA,
  BROWSER_CLOSE,
  BROWSER_EXTERNAL,
  BROWSER_FORGET_SITE,
  BROWSER_NAVIGATE,
  BROWSER_OPEN,
  BROWSER_PLACE,
  BROWSER_POLICY,
  BROWSER_POLICY_CHANGED,
  BROWSER_SHOW,
  BROWSER_SITES,
  BROWSER_STATE,
  BROWSER_TABS,
  BROWSER_TRUST_ALL,
  BROWSER_UNBLOCK,
} from './ipc.mjs'
import {
  PASSWORDS_ALLOW_SITE,
  PASSWORDS_ANSWER,
  PASSWORDS_CHANGED,
  PASSWORDS_LIST,
  PASSWORDS_NEVER,
  PASSWORDS_PROMPTS,
  PASSWORDS_PROMPTS_CHANGED,
  PASSWORDS_REMOVE,
  PASSWORDS_REMOVE_ALL,
  SIGNIN_ANSWER,
  SIGNIN_CHANGED,
  SIGNIN_LIST,
  SIGNIN_SET_TOUCH_ID,
  SIGNIN_TOUCH_ID,
} from './passwords/ipc.mjs'

const listen = (channel: string, handler: (payload: unknown) => void) => {
  const listener = (_event: unknown, payload: unknown) => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export function browserBridge() {
  return {
    place: (tabId: string | null, rect: unknown) =>
      ipcRenderer.send(BROWSER_PLACE, { tabId, rect }),
    open: (owner: { deviceId: string; threadId: string }, url: string) =>
      ipcRenderer.invoke(BROWSER_OPEN, { owner, url }),
    navigate: (tabId: string, to: string) => ipcRenderer.send(BROWSER_NAVIGATE, { tabId, to }),
    close: (tabId: string) => ipcRenderer.send(BROWSER_CLOSE, tabId),
    openExternal: (tabId: string) => ipcRenderer.send(BROWSER_EXTERNAL, tabId),
    tabs: () => ipcRenderer.invoke(BROWSER_TABS),
    onState: (handler: (tabs: unknown) => void) => listen(BROWSER_STATE, handler),
    onShow: (handler: (tab: unknown) => void) => listen(BROWSER_SHOW, handler),
    // 设置页用：一直允许的网站、删掉、清除浏览数据
    sites: () => ipcRenderer.invoke(BROWSER_SITES),
    forgetSite: (origin: string | null) => ipcRenderer.invoke(BROWSER_FORGET_SITE, origin),
    clearData: () => ipcRenderer.invoke(BROWSER_CLEAR_DATA),
    // 信任所有网站和黑名单：设置页、审批卡片上用
    policy: () => ipcRenderer.invoke(BROWSER_POLICY),
    setTrustAll: (on: boolean) => ipcRenderer.invoke(BROWSER_TRUST_ALL, on),
    block: (site: string) => ipcRenderer.invoke(BROWSER_BLOCK, site),
    unblock: (host: string | null) => ipcRenderer.invoke(BROWSER_UNBLOCK, host),
    onPolicy: (handler: (policy: unknown) => void) => listen(BROWSER_POLICY_CHANGED, handler),
    // 已保存的密码（设置页）和登录后的保存提示（浏览器面板）：都不带密码
    passwords: {
      list: () => ipcRenderer.invoke(PASSWORDS_LIST),
      remove: (id: string) => ipcRenderer.invoke(PASSWORDS_REMOVE, id),
      removeAll: () => ipcRenderer.invoke(PASSWORDS_REMOVE_ALL),
      onChanged: (handler: () => void) => listen(PASSWORDS_CHANGED, () => handler()),
      never: () => ipcRenderer.invoke(PASSWORDS_NEVER),
      allowSite: (origin: string) => ipcRenderer.invoke(PASSWORDS_ALLOW_SITE, origin),
      prompts: () => ipcRenderer.invoke(PASSWORDS_PROMPTS),
      // 写库失败时主进程回 { error }：在这里抛成错误，界面按“没做成”说
      answer: async (id: string, answer: string) => {
        const reply: unknown = await ipcRenderer.invoke(PASSWORDS_ANSWER, { id, answer })
        const { error, code } = (reply ?? {}) as { error?: unknown; code?: unknown }
        if (typeof error === 'string') throw Object.assign(new Error(error), { code })
        return reply === true
      },
      onPrompts: (handler: (prompts: unknown) => void) =>
        listen(PASSWORDS_PROMPTS_CHANGED, handler),
    },
    // 代理请人登录（request_sign_in）：列、答（代填、自己登录、交还、拒绝），对话里的那张卡片也走这里
    signIn: {
      list: () => ipcRenderer.invoke(SIGNIN_LIST),
      // answer：done、cancel、dismiss、self，或 { fill: ref, remember }（用卡片上的账号代填）
      answer: (id: string, answer: unknown) => ipcRenderer.invoke(SIGNIN_ANSWER, { id, answer }),
      onChanged: (handler: (requests: unknown) => void) => listen(SIGNIN_CHANGED, handler),
      // “代填前要 Touch ID”：回 { available, on }（available 为假时设置页不显示这个开关）
      touchId: () => ipcRenderer.invoke(SIGNIN_TOUCH_ID),
      setTouchId: (on: boolean) => ipcRenderer.invoke(SIGNIN_SET_TOUCH_ID, on),
    },
    // 从别的浏览器导入（browser-import/bridge.mts）
    import: importBridge(),
  }
}
