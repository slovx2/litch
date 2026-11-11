import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
export async function fixtures() {
  const requests = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    requests.push(url.pathname)
    if (url.pathname === '/upload-body') {
      const hash = createHash('sha256')
      let size = 0
      req.on('data', (bytes) => {
        hash.update(bytes)
        size += bytes.length
      })
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            size,
            hash: hash.digest('hex'),
            name: decodeURIComponent(req.headers['x-name']),
            type: req.headers['content-type'],
          }),
        )
      })
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (url.pathname === '/login')
      res.setHeader('Set-Cookie', 'session=isolated-fixture; SameSite=Lax')
    const other = `http://b.test:${server.address().port}`
    if (url.pathname === '/blocked-input')
      return res.end(
        '<!doctype html><title>Unapproved site</title><h1>UNAPPROVED_CONTENT_MUST_NOT_LEAK</h1>',
      )
    if (url.pathname === '/remote-upload')
      return res.end(`<!doctype html><title>Remote upload</title>
      <input id="remote-file" type="file" hidden accept=".txt"><button onclick="document.getElementById('remote-file').click()">Remote trigger</button>
      <button onclick="const f=document.createElement('input');f.type='file';f.id='dynamic-file';f.hidden=true;this.after(f);f.click()">Remote dynamic</button>`)
    if (url.pathname === '/chooser')
      return res.end(`<!doctype html><title>Upload chooser</title>
      <section><input id="file" type="file" style="visibility:hidden;height:0" accept=".txt">
      <button onclick="document.getElementById('file').click()">Select file</button></section>
      <section><button onclick="const f=document.createElement('input');f.type='file';f.id='dynamic';f.hidden=true;this.after(f);f.click()">Dynamic file</button></section>
      <label for="label-file"><span role="button" tabindex="0">Label file</span></label><input id="label-file" type="file" hidden>
      <form><button type="button">Associated file</button><input type="file" hidden></form>
      <script>window.uploadResults=[];document.addEventListener('change',async e=>{
        for(const file of e.target.files||[]){ const response=await fetch('/upload-body',{method:'POST',headers:{'x-name':encodeURIComponent(file.name),'Content-Type':file.type},body:file});
        uploadResults.push(await response.json()); }
      });</script>`)
    res.end(`<!doctype html><title>Chrome acceptance</title><style>body{background:white;color:black;padding:20px}button{padding:20px}</style>
      <h1>Chrome acceptance</h1><p>${req.headers.cookie?.includes('session=isolated-fixture') ? 'SESSION OK' : 'NO SESSION'}</p>
      <button id="count" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>
      <input placeholder="Fixture input"><input type="password" value="fixture-secret">
      <input type="file" multiple aria-label="Upload fixture">
      ${url.pathname === '/upload-frame' ? '<iframe src="/upload" title="Upload frame"></iframe>' : ''}
      ${
        url.pathname === '/upload'
          ? `<div role="button" tabindex="0" aria-label="Drop fixture" id="drop">Drop files</div>
      <script>
        window.uploadResults=[]; window.uploadEvents=[];
        const send=async files=>{for(const file of files) {
          const response=await fetch('/upload-body',{method:'POST',headers:{'x-name':encodeURIComponent(file.name),'Content-Type':file.type||'application/octet-stream'},body:file});
          window.uploadResults.push({...await response.json(),lastModified:file.lastModified});
        }};
        const input=document.querySelector('input[type=file]');
        for(const type of ['input','change'])input.addEventListener(type,event=>{uploadEvents.push({type,trusted:event.isTrusted});if(type==='change')send(input.files)});
        for(const type of ['dragenter','dragover','drop'])document.querySelector('#drop').addEventListener(type,event=>{event.preventDefault();uploadEvents.push({type,trusted:event.isTrusted});if(type==='drop')send(event.dataTransfer.files)});
      </script>`
          : ''
      }
      <button id="popup" onclick="window.open('${other}/popup')">Open popup</button>
      ${
        url.pathname.startsWith('/input')
          ? `
      <a href="/input-next?signature=fixture-private-signature#fixture-secret-fragment">Navigate fixture</a>
      <a href="${other}/blocked-input">Cross origin fixture</a>
      <button onclick="setTimeout(()=>{history.pushState({},'', '/input-spa');document.querySelector('#result').textContent='Saved fixture'},350)">Save SPA</button>
      <button onclick="void 0">No change</button><div id="result"></div>
      <input autocomplete="one-time-code" value="fixture-otp-secret" aria-label="Verification code">
      `
          : ''
      }
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
