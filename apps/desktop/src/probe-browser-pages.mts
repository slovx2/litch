// 内置浏览器自检用的测试网页，由 probe-browser.mts 在回环上起服务器提供。
// 路径：/form（表单、下拉、勾选、提交）、/upload（文件上传）、/dialog（alert、confirm）、/frame（同源 iframe）、
// /long（长页面，滚动用）、/late（半秒后才出现的元素）、/console（控制台消息）、/popup（开新窗口）、
// /link（指向另一个来源的链接，代理在用时要被拦下）、/redirect（服务器重定向到另一个来源）、/perm（申请权限）。
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px sans-serif;margin:16px}button{padding:6px 12px}</style></head><body>${body}</body></html>`

const PAGES: Record<string, (origin: string, other: string) => string> = {
  '/': () => page('首页', '<h1>Litch browser probe</h1><p>hello</p>'),
  '/form': () =>
    page(
      'Form',
      `<h1>Sign up</h1>
<form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent='submitted '+[name.value,color.value,agree.checked].join('|')">
<label>Name <input id="name" name="name"></label>
<label>Color <select id="color"><option value="r">Red</option><option value="g">Green</option></select></label>
<label><input type="checkbox" id="agree"> Agree</label>
<button id="go" type="submit">Submit</button>
</form><p id="out">waiting</p>
<button id="big" style="position:absolute;left:300px;top:400px;width:160px;height:60px" onclick="document.title='coords'">Far button</button>`,
    ),
  '/upload': () =>
    page(
      'Upload',
      `<label>File <input type="file" id="file" onchange="document.getElementById('picked').textContent=this.files[0]?.name||''"></label><p id="picked"></p>`,
    ),
  '/dialog': () =>
    page(
      'Dialog',
      `<button id="ask" onclick="document.getElementById('answer').textContent=String(confirm('Really?'))">Ask</button>
<button id="warn" onclick="alert('Heads up');document.getElementById('answer').textContent='alerted'">Warn</button>
<p id="answer">none</p>`,
    ),
  '/frame': () =>
    page('Frame', `<h1>Outer</h1><iframe src="/inner" width="400" height="200"></iframe>`),
  '/inner': () =>
    page(
      'Inner',
      `<button id="in" onclick="parent.document.title='inner clicked'">Inner button</button>`,
    ),
  '/long': () =>
    page('Long', `${Array.from({ length: 200 }, (_x, i) => `<p>Line ${i}</p>`).join('')}`),
  '/late': () =>
    page(
      'Late',
      `<p>wait</p><script>setTimeout(()=>{const b=document.createElement('button');b.id='late';b.textContent='Late button';document.body.append(b)},500)</script>`,
    ),
  '/console': () =>
    page(
      'Console',
      `<script>console.log('hello-console');console.warn('careful-console');console.error('broken-console')</script>`,
    ),
  '/popup': () =>
    page('Popup', `<button id="pop" onclick="window.open('/form')">Open window</button>`),
  '/link': (_origin, other) =>
    page(
      'Link',
      `<a id="away" href="${other}/">Go elsewhere</a> <a id="near" href="/form">Form</a>`,
    ),
  '/perm': () =>
    page(
      'Perm',
      `<p id="state">asking</p><script>Notification.requestPermission().then(r=>document.getElementById('state').textContent=r)</script>`,
    ),
  '/secret': () => page('Secret', '<p>external page</p>'),
}

export interface ProbeSite {
  server: Server
  /** 本机来源：http://127.0.0.1:端口 */
  local: string
  /** 要审批的两个来源：靠 host-resolver-rules 解析到回环 */
  site: string
  other: string
  close(): void
}

export async function startPages(): Promise<ProbeSite> {
  let port = 0
  const site = () => `http://site.example:${port}`
  const other = () => `http://other.example:${port}`
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x')
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: `${other()}/secret` })
      response.end()
      return
    }
    const render = PAGES[url.pathname]
    if (!render) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    response.setHeader('content-type', 'text/html; charset=utf-8')
    response.end(render(`http://${request.headers.host}`, other()))
  }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
  return {
    server,
    local: `http://127.0.0.1:${port}`,
    site: site(),
    other: other(),
    close: () => server.close(),
  }
}
