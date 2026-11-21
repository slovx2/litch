import type { ChromeErrorCode } from '../../automation-contracts/src/litch/chrome-browser.mjs'

type Text = (zh: string, en: string) => string

export function chromeText(chrome: any): Text {
  const zh = chrome.i18n?.getUILanguage?.().toLowerCase().startsWith('zh')
  return (chinese, english) => (zh ? chinese : english)
}

/** 只依据明确的 URL 边界预检；普通站点的运行时限制由 Chrome 原始错误说明。 */
export function restrictedPage(url: string, tr: Text): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const next = tr(
    '请新开普通 HTTP(S) 网页标签后再认领。',
    'Open a new regular HTTP(S) tab and claim it instead.',
  )
  if (
    ['http:', 'https:'].includes(parsed.protocol) &&
    (parsed.hostname === 'chromewebstore.google.com' ||
      (parsed.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/.test(parsed.pathname)))
  )
    return `${tr('Chrome 网上应用店属于受限页面，Chrome 不允许扩展接管。', 'Chrome Web Store is a restricted page; Chrome does not allow extensions to control it.')} ${next}`
  if (parsed.protocol === 'chrome-error:' || url === 'about:neterror')
    return `${tr('这是 Chrome 错误页，无法接管。', 'This is a Chrome error page and cannot be controlled.')} ${next}`
  if (parsed.protocol === 'chrome-extension:')
    return `${tr('这是扩展页面，无法作为普通网页接管。', 'This is an extension page and cannot be controlled as a regular webpage.')} ${next}`
  if (['chrome:', 'chrome-untrusted:', 'devtools:'].includes(parsed.protocol))
    return `${tr('这是 Chrome 内部页面，无法接管。', 'This is an internal Chrome page and cannot be controlled.')} ${next}`
  return null
}

export function attachFailure(
  raw: string,
  url: string,
  tr: Text,
): { code: ChromeErrorCode; message: string } {
  // 企业策略可以禁止全部目标；新开网页也不能解决，不能误报成单页限制。
  let code: ChromeErrorCode = 'targetUnavailable'
  let reason: string
  if (/restricted by policy|ExtensionsSettings policy|blocked by.*policy/i.test(raw))
    reason = tr(
      'Chrome 管理策略禁止调试此目标。请联系管理员核对扩展策略。',
      'Chrome management policy blocks debugging this target. Ask the administrator to check extension policies.',
    )
  else if (/another debugger|already attached|DevTools/i.test(raw)) {
    code = 'busy'
    reason = tr(
      'Chrome 报告目标已有调试器或 DevTools 连接。释放该连接后再认领。',
      'Chrome reports an existing debugger or DevTools connection. Release that connection before claiming again.',
    )
  } else if (
    /No (?:tab|target) with given id|target (?:closed|disappeared)|Cannot find tab/i.test(raw)
  ) {
    code = 'staleDocument'
    reason = tr(
      'Chrome 目标已关闭或变化。请重新列出标签页。',
      'The Chrome target closed or changed. List tabs again.',
    )
  } else {
    reason =
      restrictedPage(url, tr) ??
      (/Cannot access|cannot be scripted|not allowed|restricted|not permitted/i.test(raw)
        ? tr(
            'Chrome 拒绝调试此页面或其中的框架。请新开普通 HTTP(S) 网页标签后再认领。',
            'Chrome denied debugging this page or one of its frames. Open a new regular HTTP(S) tab and claim it instead.',
          )
        : tr(
            'Chrome 无法接管此标签。请按原始错误处理，或新开普通 HTTP(S) 网页标签。',
            'Chrome cannot attach to this tab. Follow the original error, or open a new regular HTTP(S) tab.',
          ))
  }
  return { code, message: `${reason} ${tr('Chrome 原始错误：', 'Original Chrome error:')} ${raw}` }
}
