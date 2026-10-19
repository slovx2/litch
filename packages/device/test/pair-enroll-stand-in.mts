// 真 sshd 端到端测试里代替适配器命令行的 pair-enroll 子命令（那一份是 Go 写的，归命令行那条线）：
// 用法 pair-enroll-stand-in.mjs <设备套接字> pair-enroll --home <目录> <配对号>（--home 不看，套接字由第一个参数给）。
// 读标准输入的一行，调 litch/pair/enroll，把结果写成一行到标准输出后退出；连不上回 unavailable。
import { unixConnector } from '../src/sockets.mjs'

const [socket, verb, ...rest] = process.argv.slice(2)
const pairId = rest.at(-1)

function finish(output: unknown): void {
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0))
}

async function readLine(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    const end = text.indexOf('\n')
    if (end >= 0) return text.slice(0, end)
    if (text.length > 4096) break
  }
  return text
}

async function main(): Promise<void> {
  if (verb !== 'pair-enroll' || !socket || !pairId) {
    finish({ ok: false, error: 'invalid', message: 'usage' })
    return
  }
  let input: unknown
  try {
    input = JSON.parse(await readLine())
  } catch {
    finish({ ok: false, error: 'invalid', message: 'bad input' })
    return
  }
  try {
    const wire = await unixConnector(socket)({
      message: (text) => {
        const frame = JSON.parse(text)
        if (frame.id === 1)
          finish(
            frame.error
              ? { ok: false, error: 'unavailable', message: frame.error.message }
              : frame.result,
          )
      },
      close: () => finish({ ok: false, error: 'unavailable', message: 'closed' }),
    })
    wire.send(JSON.stringify({ id: 1, method: 'litch/pair/enroll', params: { pairId, input } }))
  } catch (error) {
    finish({ ok: false, error: 'unavailable', message: String(error) })
  }
}

void main()
