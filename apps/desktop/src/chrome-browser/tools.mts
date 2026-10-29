import { statSync } from 'node:fs'
import type { ClientToolCallResponse } from '../../../../packages/protocol/src/client-tools.mjs'
import { chromeOrigin } from '../../../chrome-extension/src/origin.mjs'
import type { Call } from '../browser/executor.mjs'
import type { BrowserHost } from '../browser/model.mjs'
import { TOOLS } from '../browser/tools.mjs'
import { isOpenable, toAddress } from '../browser/url.mjs'
import type { ClientToolContext, ClientToolInvocation } from '../client-tools/types.mjs'
import { ChromeBridgeError } from './bridge.mjs'
import type { ChromeExecutor } from './executor.mjs'
import type { ChromePage } from './page.mjs'

const done = (text: string, images: string[] = []): ClientToolCallResponse => ({
  success: true,
  contentItems: [
    { type: 'inputText', text },
    ...images.map((imageUrl) => ({ type: 'inputImage' as const, imageUrl })),
  ],
})
const summary = (page: ChromePage): string =>
  JSON.stringify({
    tabId: page.id,
    url: page.state.url,
    title: page.state.title,
    location: 'controller',
  })

export async function executePageTool(
  executor: ChromeExecutor,
  page: ChromePage,
  invocation: ClientToolInvocation,
  context: ClientToolContext,
  args: Record<string, unknown>,
): Promise<ClientToolCallResponse> {
  const tool = invocation.tool
  if (tool === 'release') {
    await page.release()
    return done('Released the Chrome tab. The user tab remains open.')
  }
  if (tool === 'tabs') {
    if (args.action === 'close') {
      if (page.grant.original)
        throw new ChromeBridgeError(
          'invalid',
          'This is a user tab. Use release; only the user can close it.',
        )
      await page.authorize(page.grant.origins, false)
      await page.release(true)
      return done('Closed the agent-created Chrome tab.')
    }
    if (args.action === 'keep') {
      await page.authorize(page.grant.origins, args.keep !== false)
      return done(summary(page))
    }
    if (args.action === 'select') return done(summary(page))
    if (args.action !== 'new') throw new ChromeBridgeError('invalid', 'Invalid tabs action.')
  }
  if (tool === 'show') {
    await page.request('show')
    return done(`Showing Chrome on the controller. ${summary(page)}`)
  }
  if (tool === 'request_sign_in') {
    if (typeof args.reason !== 'string' || !args.reason.trim())
      throw new ChromeBridgeError('invalid', 'Give a sign-in reason.')
    if (args.origin && args.origin !== chromeOrigin(page.state.url))
      throw new ChromeBridgeError('originNotApproved', 'The sign-in origin does not match the tab.')
    if (page.scripted) await page.history('reload', 30_000)
    await page.request('freeze')
    page.paused = true
    const release = context.hold?.()
    try {
      const answer = await context.ask({
        kind: 'chromeSignIn',
        origin: chromeOrigin(page.state.url) ?? '',
        reason: args.reason.slice(0, 200),
      })
      if (answer && answer !== 'decline' && !context.signal.aborted)
        await page.request('unfreeze', {}, false)
      return done(
        answer && answer !== 'decline'
          ? 'The user finished signing in. List tabs and claim again before observing the new document.'
          : 'Sign-in was cancelled. The tab was released.',
      )
    } finally {
      await page.release().catch(() => {})
      page.paused = false
      release?.()
    }
  }
  if (tool === 'navigate' || (tool === 'tabs' && args.action === 'new')) {
    if (args.action === 'back' || args.action === 'forward' || args.action === 'reload')
      await page.history(args.action, 30_000)
    else {
      const address = typeof args.url === 'string' ? toAddress(args.url, false) : 'about:blank'
      if (!address || !isOpenable(address))
        throw new ChromeBridgeError('invalid', 'Only HTTP(S) and about:blank URLs are supported.')
      const origin = chromeOrigin(address)
      if (!origin) throw new ChromeBridgeError('invalid', 'Unsupported URL origin.')
      await executor.approve(invocation, context, page.instanceId, [origin])
      await page.authorize([...new Set([...page.grant.origins, origin])])
      await page.load(address, 30_000)
    }
    await page.cdp('Page.getFrameTree')
    return done(
      `${summary(page)}\nChrome and localhost are on the controller, not the remote session device.`,
    )
  }
  if (tool === 'console') {
    const entries = await page.request<Array<{ level: string; text: string }>>('console', {
      clear: args.clear === true,
    })
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, args.limit)) : 50
    return done(
      entries
        .filter((entry) => !args.level || args.level === 'all' || entry.level === args.level)
        .slice(-limit)
        .map((entry) => `[${entry.level}] ${entry.text}`)
        .join('\n') || 'No console messages.',
    )
  }
  const handler = TOOLS[tool]
  if (!handler) throw new ChromeBridgeError('invalid', `Unknown browser tool: ${tool}`)
  if (tool === 'evaluate') page.scripted = true
  await page.cdp('Page.getFrameTree')
  const host: BrowserHost = {
    pages: () => [page],
    page: (id) => (id === page.id ? page : undefined),
    open: () => {
      throw new Error('Chrome creation is handled by the Chrome executor.')
    },
    close: () => {
      throw new Error('Chrome release is handled by the Chrome executor.')
    },
    setKeep: () => {},
    release: () => {},
    show: () => {},
    setNavigationGate: () => {},
  }
  const call: Call = {
    invocation,
    context,
    args,
    owner: page.grant.owner,
    host,
    resolveUrl: async (url) => url,
    describeUrl: () => null,
    pick: () => page,
    pickMaybe: () => page,
    setCurrent: () => {},
    current: () => page,
    state: () => executor.state(page),
    admit: async (url) => {
      const origin = chromeOrigin(url)
      if (!origin || !page.grant.origins.includes(origin))
        throw new ChromeBridgeError(
          'originNotApproved',
          'Claim the current document and approve its source first.',
        )
      return null
    },
    admitPage: async () => {
      await page.cdp('Page.getFrameTree')
      return null
    },
    done: (_page, text, images) => done(text, images),
    statFile: (path) => {
      try {
        const info = statSync(path)
        return { file: info.isFile(), size: info.size }
      } catch {
        return null
      }
    },
    handover: null,
  }
  const result = await handler(call)
  await page.cdp('Page.getFrameTree')
  return result
}
