import { createServer } from 'node:http'

export async function fixtures() {
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    requests.push({ host: req.headers.host, path: url.pathname, method: req.method })
    if (url.pathname.startsWith('/popup-')) {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>M0 popup destination</title>POPUP REACHED SERVER')
      return
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: `http://b.test:${server.address().port}/blocked` }).end()
      return
    }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (url.pathname === '/login')
      res.setHeader('set-cookie', 'm0_session=fixture-only; SameSite=Lax')
    const loggedIn = req.headers.cookie?.includes('m0_session=fixture-only') ?? false
    if (url.pathname === '/frame') {
      res.end(
        '<button id="frameButton" onclick="this.textContent=\'FRAME OK\'">FRAME BUTTON</button>',
      )
      return
    }
    res.end(`<!doctype html><title>Litch Chrome M0</title>
      <style>body{margin:20px;background:white;color:black}button{padding:18px}#spacer{height:1100px}</style>
      <h1>Chrome 隔离探针</h1><p id="login">${loggedIn ? 'SESSION OK' : 'NO SESSION'}</p>
      <button id="button">CLICK ME</button><input id="input" placeholder="fixture input">
      <p id="count">0</p><a id="link" href="http://b.test:${server.address().port}/blocked">cross origin</a>
      <button id="popup" onclick="window.open('http://b.test:${server.address().port}/popup')">popup</button>
      <form action="/posted" method="POST"><input name="fixture" value="fixture-only"><button>POST</button></form>
      <iframe id="frame" src="http://b.test:${server.address().port}/frame" style="display:block;width:450px;height:140px;margin-top:20px"></iframe>
      <div id="spacer"></div><button id="bottom">BOTTOM</button>
      <script>
      window.events=[];window.savedOpen=window.open;
      for(const type of ['pointerdown','mousedown','click','keydown'])document.addEventListener(type,e=>events.push({type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,target:e.target.id}),true);
      document.querySelector('#button').onclick=()=>{document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)};
      </script>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, origin: `http://a.test:${server.address().port}` }
}
