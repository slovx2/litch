// 最小 DOM 与可控绘制时钟：验证回执/生命周期，不替代真实浏览器的布局和截图验收。
export function pointerDOM() {
  let now = 0,
    next = 0
  const frames = new Map(),
    timers = new Map(),
    observers = new Set()
  const win = {
    performance: { now: () => now },
    requestAnimationFrame(fn) {
      const id = ++next
      frames.set(id, fn)
      return id
    },
    cancelAnimationFrame(id) {
      frames.delete(id)
    },
    setTimeout(fn, ms) {
      const id = ++next
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback
      }
      observe() {
        observers.add(this)
      }
      disconnect() {
        observers.delete(this)
      }
    },
  }
  const doc = {
    defaultView: win,
    hidden: false,
    createElement: (tag) => element(tag),
    createElementNS: (ns, tag) => element(tag, ns),
  }
  function element(tag, ns) {
    return {
      tag,
      namespaceURI: ns,
      ownerDocument: doc,
      dataset: {},
      attributes: {},
      children: [],
      clientWidth: 200,
      clientHeight: 100,
      isConnected: true,
      style: {
        setProperty(name, value) {
          this[name] = value
        },
      },
      setAttribute(name, value) {
        this.attributes[name] = value
      },
      append(...children) {
        this.children.push(...children)
      },
      attachShadow(options) {
        this.shadowMode = options.mode
        this.testShadow = element('shadow')
        return this.testShadow
      },
      remove() {
        this.isConnected = false
      },
    }
  }
  const parent = element('parent')
  return {
    parent,
    doc,
    get host() {
      return parent.children[0]
    },
    get svg() {
      return this.host.testShadow.children[1]
    },
    get pending() {
      return { frames: frames.size, timers: timers.size, observers: observers.size }
    },
    frame(at = now + 16) {
      now = at
      const pending = [...frames.values()]
      frames.clear()
      for (const fn of pending) fn(now)
    },
    time(at) {
      now = at
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
    },
    resize(width, height) {
      this.host.clientWidth = width
      this.host.clientHeight = height
      for (const observer of observers) observer.callback()
    },
  }
}
