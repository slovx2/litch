// 发布包的容器验证（scripts/check-adapter-package.mjs）放进容器里跑的两样小东西。
// 只用 Node 自带的模块：在“干净的机器”里是拿发布包里随带的那份 Node 跑的。
//
//   node check-adapter-package-guest.mjs model <端口写到哪个文件>
//     回环上的假模型（OpenAI 的对话补全接口，流式）：把用户说的最后一句带回来。
//     和 scripts/client-local-fixture.mjs 里的是同一种，只留了“原话带回”这一样。
//   node check-adapter-package-guest.mjs releases <目录> <端口写到哪个文件>
//     把一个目录当成发布页来供应，只认安装脚本会取的两种地址：
//       /latest/download/<文件>      /download/v<版本>/<文件>
//     目录里平铺着压缩包和校验和清单；带版本号的地址只给名字里有这个版本号的压缩包。
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'

const [mode, ...rest] = process.argv.slice(2)

/** 监听回环上系统分配的端口，把端口号写进文件：调用方读到文件就知道它起来了 */
const listen = (server, portFile) =>
  server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)))

if (mode === 'model') {
  const lastUserText = (body) => {
    const content = body.messages?.findLast((message) => message.role === 'user')?.content
    if (typeof content === 'string') return content
    return (content ?? []).map((part) => part.text ?? '').join('')
  }
  let requests = 0
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    requests++
    const text = `收到：${lastUserText(body)}`
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish = null, extra = {}) =>
      response.write(
        `data: ${JSON.stringify({
          id: `mock_${requests}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        })}\n\n`,
      )
    // 分两段发，让运行时那边产生真实的增量
    const half = Math.ceil(text.length / 2)
    chunk({ role: 'assistant', content: text.slice(0, half) })
    chunk({ content: text.slice(half) })
    chunk({}, 'stop', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    response.end('data: [DONE]\n\n')
  })
  listen(server, rest[0])
} else if (mode === 'releases') {
  const [directory, portFile] = rest
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname
    const latest = /^\/latest\/download\/([^/]+)$/.exec(path)
    const tagged = /^\/download\/v([^/]+)\/([^/]+)$/.exec(path)
    const name = basename(latest?.[1] ?? tagged?.[2] ?? '')
    const file = join(directory, name)
    // 某一版的发布页上只有那一版的压缩包
    const foreign = tagged && name.endsWith('.tar.gz') && !name.includes(`-${tagged[1]}-`)
    if (!name || foreign || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end('not found\n')
      return
    }
    response.writeHead(200, { 'Content-Length': statSync(file).size })
    createReadStream(file).pipe(response)
  })
  listen(server, portFile)
} else {
  console.error('用法见文件开头')
  process.exit(1)
}
