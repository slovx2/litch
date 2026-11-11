// 每次调用持有自己的停止信号和文档基线；取消后的异步尾巴不能继续派发输入。

import type { BrowserPage } from './model.mjs'
import { discardUpload } from './upload-cleanup.mjs'

export function guardedPage(
  page: BrowserPage,
  check: () => Promise<void>,
  observed: string | undefined,
  changed: () => void,
  observation: boolean,
): { page: BrowserPage; stamp(): string | undefined } {
  let baseline: string | undefined
  const stamp = async (): Promise<string> => {
    const tree = await page.cdp('Page.getFrameTree')
    return JSON.stringify(tree)
  }
  const guard = async (document: boolean) => {
    await check()
    if (document && !page.dialog()) {
      const current = await stamp()
      if (
        (baseline !== undefined && current !== baseline) ||
        (observed !== undefined && current !== observed)
      ) {
        changed()
        if (observation && baseline === undefined) observed = current
        if (!observation || baseline !== undefined)
          throw new Error(
            'The document changed. Take a fresh snapshot before acting; a previous action may have executed.',
          )
      }
      baseline = current
    }
    await check()
  }
  const proxy = new Proxy(page, {
    get(target, key) {
      if (key === 'discardUpload')
        return (state: string | undefined, objects: readonly string[]) =>
          target.discardUpload?.(state, objects) ??
          discardUpload(target.cdp.bind(target), state, objects)
      if (key === 'prepareObservation')
        return async () => {
          await guard(false)
          const current = await stamp()
          if (baseline !== undefined && current !== baseline) changed()
          baseline = current
          observed = current
        }
      if (key === 'cdp')
        return async (method: string, params?: Record<string, unknown>) => {
          await guard(true)
          return target.cdp(method, params)
        }
      if (key === 'interceptFileChooser' && target.interceptFileChooser)
        return async (signal: AbortSignal) => {
          await guard(true)
          return target.interceptFileChooser?.(signal)
        }
      if (key === 'pointAt')
        return async (...args: Parameters<BrowserPage['pointAt']>) => {
          await guard(true)
          return target.pointAt(...args)
        }
      if (key === 'load' || key === 'history')
        return async (...args: [never, number]) => {
          await guard(false)
          return target[key](...args)
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { page: proxy, stamp: () => baseline }
}
