// 端到端的入口脚本替桌面端调设备服务（夹具里装了适配器的那台）用的最小客户端：设备服务的套接字上跑的是 WebSocket，
// 一帧一条 JSON-RPC。这里只做到够用：握手、发带掩码的文本帧、收不分片或分片的文本帧、回 ping。
// 不替调用方握 initialize（litch/pair/* 不要求握手，和命令行 pair 一样）；要握的自己 call('initialize') 再 notify('initialized')。
// 设备发来的通知交给 onNotification。不引第三方包。
import { createHash, randomBytes } from 'node:crypto'
import { connect } from 'node:net'

/** 连上套接字，返回 { call(method, params, timeoutMs), notify(method, params), close() } */
export function deviceRpc(socketPath, onNotification = () => {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    const key = randomBytes(16).toString('base64')
    let buffer = Buffer.alloc(0)
    let upgraded = false
    let fragments = []
    let next = 0
    const waiting = new Map()

    const send = (opcode, payload) => {
      const mask = randomBytes(4)
      const size = payload.length
      const head =
        size < 126
          ? Buffer.from([0x80 | opcode, 0x80 | size])
          : size < 65536
            ? Buffer.from([0x80 | opcode, 0x80 | 126, size >> 8, size & 255])
            : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), bigSize(size)])
      const body = Buffer.from(payload)
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
      socket.write(Buffer.concat([head, mask, body]))
    }
    const message = (text) => {
      let value
      try {
        value = JSON.parse(text)
      } catch {
        return
      }
      if (value.method && value.id === undefined) {
        onNotification(value.method, value.params)
        return
      }
      const pending = waiting.get(value.id)
      if (!pending || value.method) return
      waiting.delete(value.id)
      if (value.error) pending.fail(Object.assign(new Error(value.error.message), value.error))
      else pending.done(value.result)
    }
    const frames = () => {
      for (;;) {
        if (buffer.length < 2) return
        const fin = (buffer[0] & 0x80) !== 0
        const opcode = buffer[0] & 0x0f
        let size = buffer[1] & 0x7f
        let at = 2
        if (size === 126) {
          if (buffer.length < 4) return
          size = buffer.readUInt16BE(2)
          at = 4
        } else if (size === 127) {
          if (buffer.length < 10) return
          size = Number(buffer.readBigUInt64BE(2))
          at = 10
        }
        if (buffer.length < at + size) return
        const payload = buffer.subarray(at, at + size)
        buffer = buffer.subarray(at + size)
        if (opcode === 9) send(10, payload)
        else if (opcode === 8) socket.end()
        else if (opcode === 1 || opcode === 0) {
          fragments.push(payload)
          if (fin) {
            message(Buffer.concat(fragments).toString('utf8'))
            fragments = []
          }
        }
      }
    }

    socket.on('connect', () =>
      socket.write(
        [
          'GET / HTTP/1.1',
          'Host: localhost',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      ),
    )
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) return
        const head = buffer.subarray(0, end).toString('latin1')
        buffer = buffer.subarray(end + 4)
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64')
        if (!/^HTTP\/1\.1 101/.test(head) || !head.includes(accept)) {
          reject(new Error(`设备服务没有接受 WebSocket 握手：${head.split('\r\n')[0]}`))
          socket.destroy()
          return
        }
        upgraded = true
        resolve({
          call(method, params = {}, timeoutMs = 30_000) {
            const id = ++next
            return new Promise((done, fail) => {
              const timer = setTimeout(() => {
                waiting.delete(id)
                fail(new Error(`${method} ${timeoutMs} 毫秒没回`))
              }, timeoutMs)
              waiting.set(id, {
                done: (value) => {
                  clearTimeout(timer)
                  done(value)
                },
                fail: (error) => {
                  clearTimeout(timer)
                  fail(error)
                },
              })
              send(1, Buffer.from(JSON.stringify({ id, method, params })))
            })
          },
          notify(method, params = {}) {
            send(1, Buffer.from(JSON.stringify({ method, params })))
          },
          close: () => socket.end(),
        })
      }
      frames()
    })
    socket.on('error', (error) => {
      if (!upgraded) reject(error)
      for (const pending of waiting.values()) pending.fail(error)
      waiting.clear()
    })
    socket.on('close', () => {
      for (const pending of waiting.values()) pending.fail(new Error('设备服务断开了'))
      waiting.clear()
    })
  })
}

function bigSize(size) {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(size))
  return out
}
