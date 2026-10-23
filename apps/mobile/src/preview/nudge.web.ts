// 网页上 FlashList 的倒置列表（对话区）在数据变了之后不会自己重算该画哪几行，要等一次滚动：
// 新回合的卡片、回答明明在数据里，却要用户滚一下才出来。手机上没有这个问题。
// 预览里替它补上：页面一有变化，稍后给各个滚动容器派发一次 scroll 事件，列表照常按当前位置重算。
// 用定时器不用 requestAnimationFrame：页面在后台（没在看的标签页、收起的预览窗）时帧回调不跑。
// 重算没改出新东西时页面不再变，也就停了
function scrollers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('div')].filter((element) => {
    const overflow = getComputedStyle(element).overflowY
    return overflow === 'auto' || overflow === 'scroll'
  })
}

export function startScrollNudge(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      for (const element of scrollers()) element.dispatchEvent(new Event('scroll'))
    }, 30)
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => {
    observer.disconnect()
    clearTimeout(timer)
  }
}
