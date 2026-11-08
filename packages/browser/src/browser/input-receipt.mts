// 输入完成不代表业务成功。两种浏览器共用派发/观察回执，不为验证结果重放输入。
import { type ClientToolCallResponse, clientToolFailure } from '../tool-port.mjs'
import { BadArgs } from './args.mjs'
import type { Tool } from './executor.mjs'
import { isInputCommand } from './input-command.mjs'
import type { BrowserPage } from './model.mjs'
import { sleep, within } from './page-ops.mjs'

// 只用哈希比较 DOM；不返回正文、表单集合或敏感字段值。验证码与密码沿用相同遮罩规则。
export const INPUT_STATE = `(() => {
  let el = document.activeElement;
  while(el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  const secret = e => e instanceof HTMLInputElement && (e.type === 'password' || /(^|\\s)(current-password|new-password|one-time-code)(\\s|$)/i.test(e.autocomplete || ''));
  const redact = text => { for(const e of document.querySelectorAll('input')) if(secret(e) && e.value) text=text.split(e.value).join('••••••'); return text; };
  const value = el && ('value' in el || el.isContentEditable) ? (secret(el) ? '••••••' : redact(String(el.value ?? el.innerText ?? '').slice(0,500))) : null;
  let hash = 2166136261; const text = (document.body?.innerText || '').slice(0,80000);
  for(let i=0;i<text.length;i++) hash = Math.imul(hash ^ text.charCodeAt(i),16777619);
  return { url:location.href, title:redact(document.title).slice(0,200), dom:hash>>>0, document:performance.timeOrigin,
    focus:{tag:el?.tagName||null,role:el?.getAttribute('role')||null,id:secret(el)?null:el?.id||null,value,checked:typeof el?.checked==='boolean'?el.checked:null},
    scroll:[Math.round(scrollX),Math.round(scrollY)], ready:document.readyState };
})()`

export interface InputState {
  url: string
  title: string
  dom: number
  document: number
  focus: {
    tag: string | null
    role: string | null
    id: string | null
    value: string | null
    checked: boolean | null
  }
  scroll: number[]
  ready: string
}
export function receiptUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.protocol === 'about:') return 'about:blank'
    // 查询、片段和长路径段可能包含一次性凭据或签名，不进入操作回执。
    return `${url.origin}${url.pathname.replace(/[A-Za-z0-9_=-]{32,}/g, '[redacted]')}`
  } catch {
    return '[unavailable]'
  }
}
const publicState = (state: InputState | null) => {
  if (!state) return null
  const { dom: _dom, document: _document, ...view } = state
  return {
    ...view,
    url: receiptUrl(view.url),
    title: receiptError(view.title),
    focus: {
      ...view.focus,
      value: view.focus.value === null ? null : receiptError(view.focus.value),
    },
  }
}
export const inputChanges = (before: InputState, after: InputState): string[] =>
  (['url', 'title', 'document', 'dom', 'focus', 'scroll'] as const).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  )

async function sample(page: BrowserPage): Promise<InputState> {
  const reply = await page.cdp<{ result: { value?: InputState } }>('Runtime.evaluate', {
    expression: INPUT_STATE,
    returnByValue: true,
    timeout: 1000,
  })
  const state = reply.result?.value
  if (!state || typeof state.url !== 'string' || typeof state.dom !== 'number')
    throw Error('Input observation is unavailable.')
  return state
}

export const observedInput =
  (tool: Tool): Tool =>
  async (call) => {
    const page = call.pick()
    const started = Date.now()
    const beforeUrl = page.info().url
    let before: InputState | null = null
    let after: InputState | null = null
    let attempted = 0,
      dispatched = 0
    let failure: unknown
    let observationError: string | null = null
    let settled = false
    let result: ClientToolCallResponse | undefined
    const tracked = new Proxy(page, {
      get(target, key) {
        if (key === 'cdp')
          return async (method: string, params?: Record<string, unknown>) => {
            const input =
              isInputCommand(method, params) &&
              (method !== 'DOM.scrollIntoViewIfNeeded' || call.invocation.tool === 'scroll')
            if (input) attempted++
            const value = await target.cdp(method, params)
            if (input) {
              const prepared =
                method === 'Runtime.callFunctionOn'
                  ? (value as { result?: { value?: { kind?: string; ok?: boolean } } })?.result
                      ?.value
                  : null
              if (
                method === 'Runtime.callFunctionOn' &&
                (!['select', 'upload'].includes(prepared?.kind ?? '') || prepared?.ok !== true)
              )
                attempted--
              else dispatched++
            }
            return value
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    try {
      // 观察失败不能绕过就绪/来源检查；工具本身仍会执行自己的检查。
      try {
        if (!page.dialog()) before = await sample(page)
      } catch {
        /* 后面的正式检查给出拒绝原因。 */
      }
      result = await tool({ ...call, pick: () => tracked })
    } catch (error) {
      failure = error
    }

    if (attempted && !call.context.signal.aborted && !page.dialog()) {
      try {
        const deadline = Date.now() + 2500
        const bounded = <T,>(work: Promise<T>) =>
          within(
            work,
            Math.max(1, deadline - Date.now()),
            'Post-input observation exceeded 2500 ms; verify the result with a fresh snapshot or explicit wait.',
          )
        // 只恢复观察，不执行剩余输入；新来源和已撤销租约仍由页面自身的检查拒绝。
        const begin = Date.now()
        let changedAt = begin
        for (;;) {
          let next: InputState
          try {
            await bounded(page.prepareObservation?.() ?? Promise.resolve())
            next = await bounded(sample(page))
          } catch (error) {
            const transient =
              (error as { code?: string })?.code === 'staleDocument' ||
              (error instanceof Error &&
                /document changed|execution context.*destroyed|cannot find context|frame.*not found/i.test(
                  error.message,
                ))
            if (!transient || Date.now() >= deadline || call.context.signal.aborted) throw error
            await sleep(100, call.context.signal)
            continue
          }
          if (!after || inputChanges(after, next).length) changedAt = Date.now()
          after = next
          if (Date.now() - begin >= 750 && Date.now() - changedAt >= 400 && !page.info().loading) {
            settled = true
            break
          }
          if (Date.now() - begin >= 2000) break
          await sleep(100, call.context.signal)
        }
      } catch (error) {
        observationError = error instanceof Error ? error.message : String(error)
      }
    }
    const changes = before && after ? inputChanges(before, after) : []
    // 导航后的旧文档校验失败不是输入失败；只有已获派发回执并观察到变化时才作此解释。
    const navigation =
      dispatched > 0 && (beforeUrl !== page.info().url || changes.includes('document'))
    const changedDocument =
      failure instanceof Error &&
      /document changed|execution context.*destroyed|cannot find context/i.test(failure.message)
    const recovered = navigation && changedDocument
    const success = result?.success === true || recovered
    const toolError = !result?.success
      ? result?.contentItems
          .filter((item) => item.type === 'inputText')
          .map((item) => item.text)
          .join('\n')
      : undefined
    const receipt = {
      dispatch:
        attempted === 0 ? 'notDispatched' : dispatched === attempted ? 'dispatched' : 'unknown',
      eventsDispatched: dispatched,
      mayHaveExecuted: attempted > 0,
      observation: before && after ? (changes.length ? 'changed' : 'unchanged') : 'unavailable',
      changes,
      before: publicState(before),
      after: publicState(after),
      navigation,
      destination: navigation ? receiptUrl(page.info().url) : null,
      dialog: page.dialog()?.type ?? null,
      settled,
      elapsedMs: Date.now() - started,
      businessOutcome: 'unknown',
      ...(observationError ? { observationError: receiptError(observationError) } : {}),
      ...(toolError ? { error: receiptError(toolError) } : {}),
      ...(failure
        ? recovered
          ? { recoveredDocument: true }
          : { error: receiptError(failure instanceof Error ? failure.message : String(failure)) }
        : {}),
    }
    const note = navigation
      ? `Input was dispatched; navigation observed to ${receiptUrl(page.info().url)}. Business outcome is not verified. Do not replay the input.${!after ? ' Page content was not observed; check site permissions and take a fresh snapshot.' : ''}`
      : attempted > 0
        ? `Input ${receipt.dispatch}. Page observation: ${receipt.observation}. Business outcome is not verified; check the expected result before repeating input.`
        : 'No input was dispatched.'
    const errors = !success
      ? (result?.contentItems ??
        clientToolFailure(
          failure instanceof BadArgs ? 'invalid' : 'failed',
          receiptError(failure instanceof Error ? failure.message : String(failure)),
        ).contentItems)
      : []
    // 保留原通道的重要提示（被拦的来源、弹窗、下载、对话框），只改掉把派发称为已完成的动词。
    const details =
      success && result
        ? result.contentItems.map((item) =>
            item.type === 'inputText'
              ? {
                  ...item,
                  text: receiptError(
                    item.text
                      .replace(/\nTab [^\n]*/g, '')
                      .replace(/\bClicked\b/g, 'Click input dispatched')
                      .replace(/\bTyped\b/g, 'Text input dispatched')
                      .replace(/\bPressed\b/g, 'Key input dispatched')
                      .replace(/\bSelected\b/g, 'Selection command dispatched')
                      .replace(/\bScrolled\b/g, 'Scroll command dispatched'),
                  ),
                }
              : item,
          )
        : []
    const notices = page.takeNotices().map(receiptError)
    return {
      success,
      contentItems: [
        ...errors,
        {
          type: 'inputText',
          text:
            note +
            (page.dialog()
              ? ` A ${page.dialog()?.type} dialog is open; handle it with the dialog tool before continuing.`
              : ''),
        },
        { type: 'inputText', text: JSON.stringify({ inputReceipt: receipt }) },
        ...details,
        ...notices.map((text) => ({ type: 'inputText' as const, text })),
      ],
    }
  }

function receiptError(message: string): string {
  return message.replace(/https?:\/\/[^\s"']+/g, (url) => receiptUrl(url)).slice(0, 1000)
}
