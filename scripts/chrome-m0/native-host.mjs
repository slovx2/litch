// 仅供 M0：Chrome 原生消息帧 ↔ 隔离验收进程的 Unix socket。
import { createConnection } from 'node:net'

const socketPath = process.env.LITCH_CHROME_M0_SOCKET
const extensionId = process.env.LITCH_CHROME_M0_EXTENSION
if (!socketPath || process.argv[2] !== `chrome-extension://${extensionId}/`) process.exit(2)
const socket = createConnection(socketPath)
let input = Buffer.alloc(0)
let lines = ''
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  while (input.length >= 4) {
    const size = input.readUInt32LE(0)
    if (size > 16 * 1024 * 1024) process.exit(3)
    if (input.length < size + 4) break
    const payload = input.subarray(4, size + 4)
    JSON.parse(payload.toString())
    socket.write(`${payload}\n`)
    input = input.subarray(size + 4)
  }
})
socket.on('data', (chunk) => {
  lines += chunk
  for (;;) {
    const index = lines.indexOf('\n')
    if (index < 0) break
    const payload = Buffer.from(lines.slice(0, index))
    lines = lines.slice(index + 1)
    if (payload.length > 512 * 1024) process.exit(4)
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32LE(payload.length)
    process.stdout.write(Buffer.concat([prefix, payload]))
  }
})
socket.on('error', () => process.exit(5))
socket.on('close', () => process.exit())
process.stdin.on('end', () => socket.end())
