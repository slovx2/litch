// expo-modules-core 的替身：requireNativeModule 给一个转发对象，方法由测试装进 natives[模块名]。
// 没装的方法一调就报错，免得测试悄悄走了一条没打算走的路。
export const natives = {}

export function requireNativeModule(name) {
  return new Proxy(
    {},
    {
      get(_, method) {
        return (...args) => {
          const impl = natives[name]?.[method]
          if (!impl) throw new Error(`测试没有装原生方法 ${name}.${String(method)}`)
          return impl(...args)
        }
      },
    },
  )
}
