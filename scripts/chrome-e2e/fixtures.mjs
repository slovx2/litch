import { createServer } from 'node:http'
export async function fixtures() {
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    requests.push(url.pathname)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/login')
      res.setHeader('Set-Cookie', 'session=isolated-fixture; SameSite=Lax')
    const other = `http://b.test:${server.address().port}`
    res.end(`<!doctype html><title>Chrome acceptance</title><style>body{background:white;color:black;padding:20px}button{padding:20px}</style>
      <h1>Chrome acceptance</h1><p>${req.headers.cookie?.includes('session=isolated-fixture') ? 'SESSION OK' : 'NO SESSION'}</p>
      <button id="count" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>
      <input placeholder="Fixture input"><input type="password" value="fixture-secret">
      <button id="popup" onclick="window.open('${other}/popup')">Open popup</button>
      ${url.pathname === '/frames' ? `<iframe src="${other}/frame"></iframe>` : ''}
      <script>console.log('fixture console ready')</script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    requests,
    origin: `http://a.test:${server.address().port}`,
    other: `http://b.test:${server.address().port}`,
  }
}
