// 这台电脑是哪种系统。只用来决定快捷键怎么写、怎么认（Cmd 还是 Ctrl），和标题栏要不要给系统的窗口按钮让位置
// （main.tsx 把它写在根元素的 data-platform 上），别的地方不该按系统分叉。
// 桌面外壳给的是 Node 的叫法（darwin、win32、linux），普通浏览器里只有 navigator.platform（MacIntel、Win32、Linux x86_64）。

export type Platform = 'mac' | 'win' | 'linux'

/** 先认 mac：darwin 这个词里也有 win 三个字母，顺序反了就认错 */
export function platformOf(name: string): Platform {
  if (name === 'darwin' || /mac|iphone|ipad/i.test(name)) return 'mac'
  if (/^win/i.test(name)) return 'win'
  return 'linux'
}

export const currentPlatform = (): Platform =>
  platformOf(window.litchShell?.platform ?? navigator.platform)
