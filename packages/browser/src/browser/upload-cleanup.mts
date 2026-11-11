import type { BrowserPage } from './model.mjs'

/** 取消只允许清理已持有的对象，不观察页面或派发输入。租约和来源检查仍由宿主执行。 */
export async function discardUpload(
  cdp: BrowserPage['cdp'],
  state: string | undefined,
  objects: readonly string[],
): Promise<void> {
  if (state)
    await cdp('Runtime.callFunctionOn', {
      objectId: state,
      functionDeclaration: 'function(){this.clear()}',
    }).catch(() => {})
  await Promise.allSettled(objects.map((objectId) => cdp('Runtime.releaseObject', { objectId })))
}
