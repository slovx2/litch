import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcPeer, WireMessage } from '../../../shared/src/types.mjs'
import { AntigravityServer, type ServerOptions } from '../../src/server.mjs'

export async function fixture(options: ServerOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), 'litch-agy-test-'))
  const server = new AntigravityServer(home, { env: { GEMINI_API_KEY: 'fake-key' }, ...options })
  const messages: any[] = []
  const methods = new Map<number, string>()
  const peer: RpcPeer = {
    id: 'client',
    close() {},
    send(message: WireMessage) {
      messages.push(structuredClone(message))
    },
  }
  let id = 0
  const call = async (method: string, params: any = {}): Promise<any> => {
    const key = ++id
    methods.set(key, method)
    await server.handle(peer, { id: key, method, params })
    const response = messages.find((message) => message.id === key && !message.method)
    assert.ok(response, `没有应答 ${method}`)
    if (response.error)
      throw Object.assign(new Error(response.error.message), { code: response.error.code })
    return response.result
  }
  const wait = async (method: string): Promise<any> => {
    const start = Date.now()
    while (Date.now() - start < 15000) {
      const item = messages.find((message) => message.method === method)
      if (item) return item
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`等待 ${method} 超时：${JSON.stringify(messages)}`)
  }
  await call('initialize', { clientInfo: { name: 'test', version: '1' } })
  return {
    home,
    server,
    peer,
    messages,
    methods,
    call,
    wait,
    async close() {
      await server.close()
      await rm(home, { recursive: true, force: true })
    },
  }
}
