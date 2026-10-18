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

/** 两出各是哪一种：网站（浏览器打开一个没去过的地方）、应用（Computer Use 操作一个高风险的应用） */
export type ClientToolDemo = 'site' | 'app'

const CALLS: Record<ClientToolDemo, { namespace: string; tool: string; args: JsonValue }> = {
  site: {
    namespace: CLIENT_TOOL_NAMESPACE.browser,
    tool: 'navigate',
    args: { url: 'https://example.com/docs/start' },
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
              text: demo === 'site' ? 'Opened https://example.com/docs/start' : 'Safari · 1 window',
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

/** 那一次调用要用户点头的卡片。远程设备上的会话操作应用时没有“始终允许” */
export function clientAskRequest(
  demo: ClientToolDemo,
  id: string,
  itemId: string,
  device: DeviceView,
): ClientAskRequest {
  const call = CALLS[demo]
  const ask: ClientAskView =
    demo === 'site'
      ? { kind: 'site', origin: 'https://example.com', url: 'https://example.com/docs/start' }
      : {
          kind: 'app',
          app: { name: 'Safari', bundleId: 'com.apple.Safari' },
          risk: 'elevated',
          allowAlways: device.kind !== 'ssh',
        }
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
