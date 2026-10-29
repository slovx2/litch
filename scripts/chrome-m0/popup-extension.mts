// M0 补充：每次仅开启一种弹窗防护，所有状态限于本轮隔离 Chrome。
export function popupProbe(chrome: any, cdp: any, evaluate: any, events: unknown[]) {
  let parentId: number | null = null
  let mode = 'none'
  const children = new Set<number>()
  chrome.tabs.onCreated.addListener(async (tab: any) => {
    if (tab.openerTabId !== parentId || typeof tab.id !== 'number') return
    children.add(tab.id)
    events.push({ kind: 'created', mode, tabId: tab.id, openerTabId: tab.openerTabId })
    try {
      if (mode === 'onCreated-close') await chrome.tabs.remove(tab.id)
      if (mode === 'onCreated-attach') {
        await chrome.debugger.attach({ tabId: tab.id }, '1.3')
        await cdp(tab.id, 'Fetch.enable', {
          patterns: [{ urlPattern: '*', resourceType: 'Document' }],
        })
      }
    } catch (error) {
      events.push({ kind: 'createdError', mode, error: String(error) })
    }
  })
  chrome.debugger.onEvent.addListener(async (source: any, method: string, params: any) => {
    if (source.tabId !== parentId && !children.has(source.tabId)) return
    if (method === 'Target.attachedToTarget') {
      events.push({
        kind: 'autoAttach',
        mode,
        type: params.targetInfo.type,
        waiting: params.waitingForDebugger,
        url: params.targetInfo.url,
      })
      try {
        if (mode === 'autoAttach-wait' && params.targetInfo.type === 'page') {
          await cdp(
            source.tabId,
            'Fetch.enable',
            { patterns: [{ urlPattern: '*', resourceType: 'Document' }] },
            params.sessionId,
          )
        }
        if (params.waitingForDebugger)
          await cdp(source.tabId, 'Runtime.runIfWaitingForDebugger', {}, params.sessionId)
      } catch (error) {
        events.push({ kind: 'autoAttachError', error: String(error) })
      }
    }
    if (
      method === 'Fetch.requestPaused' &&
      (children.has(source.tabId) || (mode === 'autoAttach-wait' && source.sessionId))
    ) {
      try {
        await cdp(
          source.tabId,
          'Fetch.failRequest',
          { requestId: params.requestId, errorReason: 'BlockedByClient' },
          source.sessionId,
        )
        events.push({ kind: 'popupBlocked', mode, url: params.request.url })
      } catch (error) {
        events.push({ kind: 'blockError', error: String(error) })
      }
    }
  })
  return async (args: any) => {
    mode = args.mode
    parentId = args.tabId
    children.clear()
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1] })
    if (mode.startsWith('dnr-')) {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: 1,
            priority: 1,
            action: { type: 'block' },
            condition: {
              resourceTypes: ['main_frame'],
              requestDomains: ['b.test'],
              ...(mode === 'dnr-initiator'
                ? { initiatorDomains: ['a.test'] }
                : { tabIds: [args.tabId] }),
            },
          },
        ],
      })
    }
    if (mode === 'isolated-open') {
      const { frameTree } = await cdp(args.tabId, 'Page.getFrameTree')
      const { executionContextId } = await cdp(args.tabId, 'Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: 'm0-popup',
      })
      await evaluate(
        args.tabId,
        'window.open = () => { globalThis.blockedOpen = true; return null }',
        executionContextId,
      )
    }
    if (mode === 'main-open') {
      await evaluate(
        args.tabId,
        'window.open = () => { globalThis.blockedOpen = true; return null }',
      )
    }
    if (mode === 'autoAttach-wait') {
      await cdp(args.tabId, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [{ type: 'page' }, { type: 'iframe' }, { exclude: true }],
      })
    }
    return { mode, parentId }
  }
}
