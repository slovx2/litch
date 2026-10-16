// 几件要等的事先后发出去，只让最后发的那一件落地。

/**
 * 等的先后和等到的先后不一定一样：后发的可能先等到。不拦的话，先发的那一件后到时会把后发的盖掉。
 * 终端换外观就是这样：换皮肤要等新字体的文件，紧跟着再换一次明暗的时候字体可能刚好到了，
 * 后一次不用等、当场落地，前一次那时才等到，落下去的却是旧的那一套。
 *
 * 返回的函数每叫一次算发出一件：wait 等到之后，只有它还是最后发出的那一件才执行 land。
 */
export function latestOnly(): (wait: Promise<unknown>, land: () => void) => void {
  let issued = 0
  return (wait, land) => {
    const mine = ++issued
    void wait.then(() => {
      if (mine === issued) land()
    })
  }
}
