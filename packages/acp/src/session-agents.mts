// Gemini 的会话进程：经理注入了 GitHub 身份的会话（经理和工作线）各用一个 agent 进程。
//
// Gemini 一个 agent 进程跑所有会话，shell 命令在进程里自己起、继承进程的环境，没有会话号；它的 ACP 会话也不跑
// 工具前钩子（0.38 的 acpSession 直接执行工具），没法像 Qwen 那样改写命令（thread-hook.mts）。所以给会话单独起
// 进程，进程环境里的 LITCH_THREAD_ID_FILE 指向一个文件，会话号写在里面（进程先起、session/new 之后才有会话号），
// 它跑的命令都认得出会话，设备据此发租约。
//
// 什么时候在哪个进程：
// - 新建的会话一律先在自己的进程里建。Gemini 要到第一条消息才把会话写盘，没写盘的会话别的进程 session/load 不出来，
//   而派出工作线时还不知道它会不会被注入（设备在会话建好后才记父子关系），只能先单独建。
// - 会话发过话以后（movable），每次接上前（AcpServer.attach）问一次设备：已注入的留在（或换到）自己的进程，没注入的
//   关掉自己的进程、回到共用的（进程编号变了，attach 照“进程换过”的路子用 session/load 接回去）。
// - 没人看、也没在跑、发过话的会话释放时关掉它自己的进程，下次接上时再起。
// 代价：普通会话第一回合多一次冷启动；已注入会话一直多占一个 Gemini 进程。
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AcpRuntime } from './runtime.mjs'

export interface SessionAgentOptions {
  /** 只有 Gemini 开 */
  enabled: boolean
  /** 会话号文件放在哪个目录 */
  directory: string
  /** 起一个会话自己的运行时，环境里的 LITCH_THREAD_ID_FILE 是 file */
  create(file: string): AcpRuntime
  /** 设备说这个会话是否已注入；问不到算否 */
  injected(threadId: string): Promise<boolean>
}

interface Own {
  runtime: AcpRuntime
  file: string
}

/** 新建会话用的运行时；会话建好后 bind，没建成 discard */
export interface Incubated {
  runtime: AcpRuntime
  bind(threadId: string): void
  discard(): Promise<void>
}

export class SessionAgents {
  private readonly shared: AcpRuntime
  private readonly options: SessionAgentOptions
  private readonly own = new Map<string, Own>()

  constructor(shared: AcpRuntime, options: SessionAgentOptions) {
    this.shared = shared
    this.options = options
  }

  /** 会话现在归哪个运行时（不问设备） */
  host(threadId: string): AcpRuntime {
    return this.own.get(threadId)?.runtime ?? this.shared
  }

  owns(threadId: string): boolean {
    return this.own.has(threadId)
  }

  private spawn(threadId?: string): Own {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const file = join(this.options.directory, `${randomUUID()}.id`)
    if (threadId) writeFileSync(file, threadId, { mode: 0o600 })
    return { runtime: this.options.create(file), file }
  }

  incubate(): Incubated {
    if (!this.options.enabled) return { runtime: this.shared, bind() {}, async discard() {} }
    const own = this.spawn()
    return {
      runtime: own.runtime,
      bind: (threadId) => {
        writeFileSync(own.file, threadId, { mode: 0o600 })
        this.own.set(threadId, own)
      },
      discard: async () => {
        await own.runtime.close()
        rmSync(own.file, { force: true })
      },
    }
  }

  /**
   * 接上会话之前：定它该在哪个运行时。没发过话的（movable 为假）留在原处：它还没写盘，换了进程接不回来。
   */
  async pick(threadId: string, movable: boolean): Promise<AcpRuntime> {
    if (!this.options.enabled) return this.shared
    const current = this.own.get(threadId)
    if (!movable) return current?.runtime ?? this.shared
    const injected = await this.options.injected(threadId).catch(() => false)
    if (injected) {
      if (current) return current.runtime
      const own = this.spawn(threadId)
      this.own.set(threadId, own)
      return own.runtime
    }
    if (current) await this.drop(threadId)
    return this.shared
  }

  /** 关掉会话自己的进程（会话删了、释放了、不再注入） */
  async drop(threadId: string, signalled = false): Promise<void> {
    const own = this.own.get(threadId)
    if (!own) return
    this.own.delete(threadId)
    await own.runtime.close(signalled)
    rmSync(own.file, { force: true })
  }

  async close(signalled = false): Promise<void> {
    await Promise.all([...this.own.keys()].map((id) => this.drop(id, signalled)))
  }
}
