// 按键存取、按键通知的小状态库。界面的每个组件只订阅自己要的那个键，
// 一段文本增量只会通知显示那一个条目的组件。
// 值一律当作不可变的：要改就换一个新对象，这样“引用变了”就等于“内容变了”。

export class KeyedStore {
  readonly #values = new Map<string, unknown>()
  readonly #listeners = new Map<string, Set<() => void>>()
  #batchDepth = 0
  readonly #dirty = new Set<string>()

  get<T>(key: string): T | undefined {
    return this.#values.get(key) as T | undefined
  }

  set(key: string, value: unknown): void {
    if (this.#values.has(key) && Object.is(this.#values.get(key), value)) return
    this.#values.set(key, value)
    this.#touch(key)
  }

  delete(key: string): void {
    if (this.#values.delete(key)) this.#touch(key)
  }

  /** 关会话时整批清理，只通知完整清理后的状态，避免卸载中的组件反复扫描历史。 */
  deletePrefix(prefix: string): void {
    this.batch(() => {
      for (const key of this.#values.keys()) {
        if (key.startsWith(prefix)) this.delete(key)
      }
    })
  }

  subscribe(key: string, listener: () => void): () => void {
    const set = this.#listeners.get(key) ?? new Set<() => void>()
    this.#listeners.set(key, set)
    set.add(listener)
    let subscribed = true
    return () => {
      // 导航确认后会先退订，离开页面时还会再清理；旧清理不能删掉后来同键的新订阅。
      if (!subscribed) return
      subscribed = false
      set.delete(listener)
      if (set.size === 0) this.#listeners.delete(key)
    }
  }

  /** 一批改动合在一起通知：同一个订阅者即使监听多个键，也只通知一次。 */
  batch(apply: () => void): void {
    this.#batchDepth++
    try {
      apply()
    } finally {
      this.#batchDepth--
      if (this.#batchDepth === 0) this.#flush()
    }
  }

  #touch(key: string): void {
    this.#dirty.add(key)
    if (this.#batchDepth === 0) this.#flush()
  }

  #flush(): void {
    const keys = [...this.#dirty]
    this.#dirty.clear()
    const listeners = new Set<() => void>()
    for (const key of keys) {
      for (const listener of this.#listeners.get(key) ?? []) listeners.add(listener)
    }
    for (const listener of listeners) listener()
  }
}
