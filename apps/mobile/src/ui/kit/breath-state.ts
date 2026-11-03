/** 平台事件和动画驱动分开，便于验证后台、减弱动态及异步设置查询的交错。 */
export interface BreathDriver {
  active(): boolean
  reduced(): Promise<boolean>
  onActive(change: (active: boolean) => void): () => void
  onReduced(change: (reduced: boolean) => void): () => void
  start(): () => void
  reset(): void
}

/** 所有可见的运行记号共用一个时钟；行数增加不增加原生循环或系统订阅。 */
export function createBreathClock(driver: BreathDriver): { retain(): () => void } {
  let users = 0
  let dispose: (() => void) | undefined
  return {
    retain() {
      users += 1
      if (users === 1) {
        let alive = true
        let active = driver.active()
        // 未读到系统设置前保持静态，避免开启减弱动态的用户先看到一段动画。
        let reduced = true
        let changed = false
        let stop: (() => void) | undefined
        const update = () => {
          if (!alive) return
          if (active && !reduced) {
            stop ??= driver.start()
          } else {
            stop?.()
            stop = undefined
            driver.reset()
          }
        }
        const offActive = driver.onActive((value) => {
          active = value
          update()
        })
        const offReduced = driver.onReduced((value) => {
          changed = true
          reduced = value
          update()
        })
        void driver.reduced().then(
          (value) => {
            // 订阅后的新设置优先，迟到的初始查询不能把它覆盖。
            if (!alive || changed) return
            reduced = value
            update()
          },
          () => {},
        )
        dispose = () => {
          alive = false
          offActive()
          offReduced()
          stop?.()
          driver.reset()
        }
      }
      let released = false
      return () => {
        if (released) return
        released = true
        users -= 1
        if (users === 0) {
          dispose?.()
          dispose = undefined
        }
      }
    },
  }
}
