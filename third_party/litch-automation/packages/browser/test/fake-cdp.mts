import { CdpRefused, isAllowedCdp } from '../src/browser/cdp-allow.mjs'
import type {
  BrowserHost,
  BrowserPage,
  DialogInfo,
  TabInfo,
  TabKind,
  TabOwner,
} from '../src/browser/model.mjs'

interface FakePage extends BrowserPage {
  owner: TabOwner
  kind: TabKind
  keep: boolean
  active: boolean
  released: number
  url: string
  sent: string[]
}

export function fakeHost() {
  const pages = new Map<string, FakePage>()
  let seq = 0
  let gate: (page: BrowserPage, url: string) => boolean = () => true
  const shown: string[] = []
  const host: BrowserHost & { gate(page: BrowserPage, url: string): boolean; shown: string[] } = {
    shown,
    gate: (page, url) => gate(page, url),
    pages: () => [...pages.values()],
    page: (id) => pages.get(id),
    open(owner, kind, options = {}) {
      const id = `t${++seq}`
      const page: FakePage = {
        id,
        owner,
        kind,
        keep: options.keep === true,
        active: false,
        released: 0,
        url: 'about:blank',
        sent: [],
        info: (): TabInfo => ({
          id,
          owner: page.owner,
          kind: page.kind,
          url: page.url,
          title: `title of ${page.url}`,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          agentActive: page.active,
          keep: page.keep,
        }),
        async load(url) {
          page.url = url
          return { ok: true }
        },
        history: async () => ({ ok: true }),
        waitForLoad: async () => true,
        async cdp<T>(method: string): Promise<T> {
          if (!isAllowedCdp(method)) throw new CdpRefused(method)
          page.sent.push(method)
          if (method === 'Page.getFrameTree')
            return { frameTree: { frame: { id: 'f', url: page.url } } } as T
          if (method === 'Accessibility.getFullAXTree') {
            return {
              nodes: [
                { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
                {
                  nodeId: '2',
                  parentId: '1',
                  role: { value: 'button' },
                  name: { value: 'OK' },
                  backendDOMNodeId: 7,
                },
              ],
            } as T
          }
          if (method === 'Runtime.evaluate') return { result: { type: 'number', value: 2 } } as T
          if (method === 'DOM.getContentQuads')
            return { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] } as T
          return {} as T
        },
        consoleEntries: () => [],
        clearConsole() {},
        dialog: (): DialogInfo | null => null,
        dialogOpened: () => new Promise<DialogInfo>(() => {}),
        takeNotices: () => [],
        setAgentActive(active) {
          page.active = active
        },
        pointAt: async () => {},
      }
      pages.set(id, page)
      return page
    },
    close: (id) => void pages.delete(id),
    setKeep(id, keep) {
      const page = pages.get(id)
      if (page) page.keep = keep
    },
    release(id) {
      const page = pages.get(id)
      if (!page) return
      page.released++
      page.active = false
    },
    show: (id) => void shown.push(id),
    setNavigationGate(next) {
      gate = next
    },
  }
  return host
}
