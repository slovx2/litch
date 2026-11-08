// 新标签必须显式放进普通窗口；没有窗口时也不能让 Chrome 的默认创建行为抢焦点。
export async function createBackgroundTab(chrome: any): Promise<any> {
  const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter(
    (window: any) => !window.incognito,
  )
  const window = windows.find((window: any) => window.focused) ?? windows[0]
  if (window) return chrome.tabs.create({ windowId: window.id, url: 'about:blank', active: false })
  const created = await chrome.windows.create({
    url: 'about:blank',
    type: 'normal',
    focused: false,
  })
  const tab = created.tabs?.[0]
  if (!tab) throw new Error('The background Chrome window did not create a tab. List tabs again.')
  return tab
}
