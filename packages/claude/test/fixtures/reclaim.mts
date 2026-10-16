import { after } from 'node:test'

// 用例超时或在进入 try 之前失败时，它自己的 finally 不会执行，留下的被测进程和监听端口会让
// 测试文件一直不退出。夹具把收尾动作登记到这里，文件里的用例全部结束后统一补做；
// 正常收尾过的先注销，不会重复执行。
const pending = new Set<() => unknown>()

after(async () => {
  const results = await Promise.allSettled([...pending].map(async (close) => close()))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
})

export function reclaimAtEnd(close: () => unknown): () => void {
  pending.add(close)
  return () => void pending.delete(close)
}
