// 手机没有用户内置浏览器；网页长按菜单只提供复制和系统浏览器，文件与经理编号不进入此菜单。
export type WebLinkAction = 'copyLink' | 'openSystem'
export function webLinkActions(
  url: string,
): { id: WebLinkAction; label: 'link.menu.copy' | 'link.menu.system' }[] {
  if (!/^https?:\/\//i.test(url)) return []
  return [
    { id: 'copyLink', label: 'link.menu.copy' },
    { id: 'openSystem', label: 'link.menu.system' },
  ]
}
export async function performWebLinkAction(
  action: WebLinkAction,
  url: string,
  io: {
    copy(url: string): Promise<boolean>
    open(url: string): Promise<unknown>
  },
): Promise<void> {
  if (!webLinkActions(url).some((item) => item.id === action)) return
  if (action === 'copyLink') {
    if (!(await io.copy(url))) throw new Error('clipboard unavailable')
  } else await io.open(url)
}
