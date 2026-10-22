// 在界面脚本执行之前，把皮肤、明暗、密度、对话区宽度、语言写到根元素上，把缩放报给桌面外壳，这样启动时不会先闪一下默认外观。
// 这是一个普通脚本，不是模块：它要赶在样式和界面脚本之前同步跑完。
// 规则和 src/app/appearance.ts 是同一套，改一边要改另一边：
// 地址里的临时指定（?skin=…&theme=…&lang=…）优先，其次是记下来的选择，都没有就用默认：
// 复古皮肤、明暗跟随系统、标准密度、宽的对话区、缩放 100%；密度、对话区宽度和缩放没有地址里的临时指定。
// 语言没有“跟随系统”这一档，第一次启动时按系统语言选（系统是中文就中文，别的一律英文），由 appearance.ts 记下来。
;(() => {
  const root = document.documentElement
  let saved = {}
  try {
    saved = JSON.parse(localStorage.getItem('litch.appearance') ?? '{}') ?? {}
  } catch {
    // 读不到就用默认外观
  }
  const params = new URLSearchParams(location.search)
  const choose = (name, allowed, fallback) => {
    const value = params.has(name) ? params.get(name) : saved[name]
    return allowed.includes(value) ? value : fallback
  }
  const skin = choose('skin', ['retro', 'human', 'standard'], 'retro')
  root.dataset.skin = skin
  const theme = choose('theme', ['light', 'dark'], '')
  if (theme) root.dataset.theme = theme
  const lang = choose('lang', ['zh-CN', 'en'], '')
  root.lang = lang || (navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en')
  root.dataset.density = ['compact', 'standard', 'roomy'].includes(saved.density)
    ? saved.density
    : 'standard'
  root.dataset.chatWidth = ['wide', 'compact'].includes(saved.chatWidth) ? saved.chatWidth : 'wide'
  // 缩放是外壳做的（普通浏览器里没有外壳，这一项不起作用）。窗口刚开时外壳先按它自己记着的上一次的倍数缩放，
  // 这里再报一遍界面记着的：两边对不上的时候以界面这份为准
  const zoom = [0.8, 0.9, 1, 1.1, 1.25, 1.5].includes(saved.zoom) ? saved.zoom : 1
  window.litchShell?.setLook({ skin, theme: theme || 'system', zoom })
})()
