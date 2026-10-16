import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ProtocolError } from './protocol-contract.mjs'

// 一个 query 只持有一个输入迭代器，避免并发 streamInput 提前关闭 CLI stdin。
// 进程可以跨回合存活，所以这里只是一条消息队列：每个回合的用户消息、回合内追加的指令、
// 不触发模型请求的上下文追加，都从这里送进去。
export class NativeTurnInput implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  send(message: SDKUserMessage): void {
    if (this.closed) throw new ProtocolError(-32009, '原生回合已结束，不能追加指令')
    this.queue.push(message)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.queue = []
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift()
      if (next) yield next
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      this.wake = null
    }
  }
}
