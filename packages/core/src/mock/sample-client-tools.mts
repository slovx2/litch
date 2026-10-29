// 模拟核心里客户端工具（内置浏览器、Computer Use）那两出用的条目和卡片（关键字见 mock-core.mts 的 BROWSES、USES_APP）。
// 条目写成协议里的形状（dynamicToolCall），交给真的投影：图片走真的“头几张留缩略图”那一套。
// 卡片的选项用真的核心那一份（device/tool-calls.mts 的 clientAskOptions），界面分不出对面是谁。
import { CLIENT_TOOL_NAMESPACE } from '../../../protocol/src/client-tools.mjs'
import type { JsonValue, ThreadItem } from '../../../protocol/src/index.mjs'
import { clientAskOptions } from '../device/tool-calls.mjs'
import type { ClientAskRequest, ClientAskView, DeviceView } from '../model.mjs'

/** 一张 320×200 的示例截图：一个假的网页（地址栏、标题、几行字、一张图、一个按钮） */
export const SAMPLE_SHOT =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADICAIAAAAWZq/8AAACqUlEQVR42u3boQ2AQBBFQcpBEBTVXE1oFAJFVWiCoAIwSAwQDGKPSaaCyz3zky3mZQWCKjwBCBgQMCBgEDAgYEDAgIBBwICAAQGDgAEBAwIGBAwCBgQMCBgQMAgYEDAgYBAwECrgbduBoAQMAgYEDAgYBAwIGBAwIGAQMCBgQMAgYEDAgIABAYOAn5RVA5ekJWAEjIARsIAFjIAFjIARMAJGwAhYwCBgASNgBIyABSxgBCxgBIyAETACRsACFjACFjACxkE/CNgrgIABAQMCBgEDAgYEDAgYBAwIGBAwCBgQMCBgokvtxEsCRsACBgELGAQsYAQsYAEjYAGDgAWMgBEwAhawgBHw3wPu+pGMCVjACBgBI2ABCxgBC1jAAhawFRorNAJGwAIGAQsYBCxgBCxgASNgAYOABYyAETACFrCAEbCAQcACRsACFjACFjAIWMAgYPfAuAcWsIARsIAFLGABCxgBI2AELGArNFZoAYOABYyABSxgBCxgELCAETACRsACFjACFjAIWMAIGAEjYAH7aghYwCBgASNgAQsYAQvYPbB7YAELGAEjYAQsYAEjYAELWMACtkJjhUbACFjAIGABg4AFjIAFLGAELGAQsIARMAJGwAIWMAIWMAhYwAhYwAJGwAIGAQsYASvTPTDugQUsYAQsYAELWMACRsAIGAEL2AqNFVrAIGABI2ABCxgBCxgELGDgWwIGAQMCBgQMAgYEDAgYEDAIGMghYBez7oHv1EP6FQEjYAELGAELWMAIWMAIWMBWaAISsIARsIAFjIAFDAIWMAIWsIARsIAFjIAFDAIWMAIWsIARsIBBwAJGwAIWMAIWsIARsIBBwAIGBAwC9gogYEDAgIBBwICAAQEDAgYBAwIGBAwCBgQMCBgQMAgYEDAgYOB0AHd3bRbc0GZfAAAAAElFTkSuQmCC'

/**
 * 各出是哪一种：网站（浏览器打开一个没去过的地方）、应用（Computer Use 看一个应用，不出卡片）、
 * 代理请人登录（request_sign_in）的四样：有已存账号、库里没有、预检不过、定时任务的回合；
 * 操作这台电脑上的 Chrome 的三样：列一个 Chrome 实例的标签页、在 Chrome 里打开没去过的网站、请人在 Chrome 里登录
 */
export type ClientToolDemo = ClientAskDemo | 'app'

/** 要出卡片的那几出 */
export type ClientAskDemo = 'site' | SignInDemo | ChromeDemo

export type ChromeDemo = 'chromeInstance' | 'chromeSite' | 'chromeSignIn'

export type SignInDemo = 'signIn' | 'signInNone' | 'signInBlocked' | 'signInTask'

const SIGN_IN_CALL = {
  namespace: CLIENT_TOOL_NAMESPACE.browser,
  tool: 'request_sign_in',
  args: { tabId: 'tab-1', site: 'GitHub', reason: 'Need to open the repository settings.' },
}

const CALLS: Record<ClientToolDemo, { namespace: string; tool: string; args: JsonValue }> = {
  signIn: SIGN_IN_CALL,
  signInNone: SIGN_IN_CALL,
  signInBlocked: SIGN_IN_CALL,
  signInTask: SIGN_IN_CALL,
  site: {
    namespace: CLIENT_TOOL_NAMESPACE.browser,
    tool: 'navigate',
    args: { url: 'https://example.com/docs/start' },
  },
  chromeInstance: {
    namespace: CLIENT_TOOL_NAMESPACE.browser,
    tool: 'tabs',
    args: { action: 'list', target: 'chrome' },
  },
  chromeSite: {
    namespace: CLIENT_TOOL_NAMESPACE.browser,
    tool: 'navigate',
    args: { url: 'https://example.com/docs/start', target: 'chrome' },
  },
  chromeSignIn: {
    namespace: CLIENT_TOOL_NAMESPACE.browser,
    tool: 'request_sign_in',
    args: { target: 'chrome', reason: 'Need to open the repository settings.' },
  },
  app: {
    namespace: CLIENT_TOOL_NAMESPACE.computer,
    tool: 'get_app_state',
    args: { app: 'com.apple.Safari' },
  },
}

/**
 * 那一次工具调用。result：还在等（null）、用户答应了（shot：回一句话加一张截图）、用户拒绝了（declined：失败，
 * 说明照真的执行器的写法，第一行是 [litch:declined]）
 */
export function clientToolCall(
  demo: ClientToolDemo,
  id: string,
  result: 'shot' | 'declined' | null,
): ThreadItem {
  const call = CALLS[demo]
  const done = result !== null
  return {
    type: 'dynamicToolCall',
    id,
    namespace: call.namespace,
    tool: call.tool,
    arguments: call.args,
    status: done ? (result === 'shot' ? 'completed' : 'failed') : 'inProgress',
    contentItems:
      result === 'shot'
        ? [
            {
              type: 'inputText',
              text:
                demo === 'site' || demo === 'chromeSite'
                  ? 'Opened https://example.com/docs/start'
                  : demo === 'chromeInstance'
                    ? 'Chrome · 3 tabs'
                    : demo === 'chromeSignIn'
                      ? 'The user finished signing in; the page reloaded. Claim the tab again.'
                      : demo === 'app'
                        ? 'Safari · 1 window'
                        : 'Litch filled the account the user approved and submitted; the page loaded https://github.com. Take a fresh snapshot to check you are signed in.',
            },
            { type: 'inputImage', imageUrl: SAMPLE_SHOT },
          ]
        : result === 'declined'
          ? [{ type: 'inputText', text: '[litch:declined] The user declined this request.' }]
          : null,
    success: done ? result === 'shot' : null,
    durationMs: done ? 640 : null,
  }
}

/** 那一次调用要用户点头的卡片 */
export function clientAskRequest(
  demo: ClientAskDemo,
  id: string,
  itemId: string,
  device: DeviceView,
): ClientAskRequest {
  const call = CALLS[demo]
  const ask: ClientAskView =
    demo === 'site'
      ? { kind: 'site', origin: 'https://example.com', url: 'https://example.com/docs/start' }
      : demo === 'chromeSite'
        ? {
            kind: 'site',
            origin: 'https://example.com',
            url: 'https://example.com/docs/start',
            browser: 'chrome',
          }
        : demo === 'chromeInstance'
          ? { kind: 'chromeInstance', instanceId: 'chrome-1', name: 'Chrome · 3f9a1c27' }
          : demo === 'chromeSignIn'
            ? {
                kind: 'chromeSignIn',
                origin: 'https://github.com',
                reason: 'Need to open the repository settings.',
              }
            : signInAsk(demo, id)
  return {
    id,
    kind: 'clientAsk',
    itemId,
    device: { name: device.name, kind: device.kind, host: device.host },
    tool: { namespace: call.namespace, name: call.tool },
    ask,
    options: clientAskOptions(ask),
  }
}

/** 登录卡片的样例：两个已存账号（一个用过），库里没有时是空的；预检不过的是 http 页面；定时任务的 30 分钟后过期 */
function signInAsk(demo: SignInDemo, id: string): ClientAskView {
  const accounts =
    demo === 'signInNone'
      ? []
      : [
          {
            ref: `${id}-a1`,
            username: 'song@example.com',
            masked: 'so•••@example.com',
            lastUsed: Date.now() - 3 * 86_400_000,
          },
          { ref: `${id}-a2`, username: 'ops-bot', masked: 'op•••', lastUsed: null },
        ]
  const task = demo === 'signInTask'
  return {
    kind: 'signIn',
    id: `${id}-sign-in`,
    origin: demo === 'signInBlocked' ? 'http://login.example.com' : 'https://accounts.github.com',
    site: 'GitHub',
    reason: 'Need to open the repository settings.',
    accounts,
    fillBlocked: demo === 'signInBlocked' ? 'insecure' : null,
    taskId: task ? 'task-nightly' : null,
    expiresAt: task ? Date.now() + 30 * 60_000 : null,
    nonce: `${id}-nonce`,
  }
}
