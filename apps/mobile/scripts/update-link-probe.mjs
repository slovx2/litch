// 用宿主请求计数区分“没有横条”和“深链真的未生效”；只返回清单，不提供可安装的包。
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function startUpdateLinkProbe() {
  let requests = 0
  let downloads = 0
  const server = createServer((request, response) => {
    if (request.url === '/feed') {
      requests++
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          version: '99.0.0',
          assets: {
            'android-arm64': {
              url: `http://127.0.0.1:${server.address().port}/never.apk`,
              sha256: 'a'.repeat(64),
              size: 1,
            },
          },
        }),
      )
    } else {
      downloads++
      response.writeHead(404).end()
    }
  })
  await new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', done)
  })
  const port = String(server.address().port)
  return {
    port,
    url: `http://127.0.0.1:${port}/feed`,
    count: () => requests,
    verify(before, production) {
      assert.equal(downloads, 0, '检查更新不应自行下载安装包')
      if (production) assert.equal(requests, before, '发布包请求了深链提供的更新源')
      else assert.ok(requests > before, 'E2E 包没有请求测试更新源')
      return { feedRequests: requests - before, downloads }
    },
    stop: () => new Promise((done) => server.close(done)),
  }
}
