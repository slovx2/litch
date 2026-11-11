// 只使用此进程新建的隐藏视图、临时分区和假加密器；不访问真实钥匙串。
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { createBrowserExecutor } from '../src/browser/executor.mjs'
import { createElectronHost, restoreBrowserCookies } from '../src/electron.mjs'
import { createCdpDriver, createSiteBook } from '../src/index.mjs'

const profile = process.env.BROWSER_FIXTURE_PROFILE
assert.ok(profile)
app.setPath('userData', profile)
app.setName('Browser Package Fixture')
app.commandLine.appendSwitch('use-mock-keychain')
BrowserWindow.prototype.show = () => {
  throw new Error('验收禁止显示窗口')
}
BrowserWindow.prototype.showInactive = () => {
  throw new Error('验收禁止显示窗口')
}
void app
  .whenReady()
  .then(async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end(
        '<title>Host injection</title><button>Owned fixture</button><label>Nebula password<input id="password" type="password" autocomplete="current-password"></label><label>Nebula code<input id="code" autocomplete="one-time-code"></label><label>Nebula card<input id="card" autocomplete="cc-number"></label>' +
          '<section><input id="hidden-file" type="file" accept=".txt" style="visibility:hidden;height:0"><button onclick="document.getElementById(\'hidden-file\').click()">Select file</button></section>' +
          "<section><button onclick=\"const f=document.createElement('input');f.type='file';f.id='dynamic-file';f.style.display='none';this.after(f);f.click()\">Dynamic file</button></section>" +
          '<section><label for="label-file"><span role="button" tabindex="0">Label file</span></label><input id="label-file" type="file" hidden></section>' +
          '<section><label for="fallback-file" onclick="event.preventDefault()"><span role="button" tabindex="0">Label fallback</span></label><input id="fallback-file" type="file" hidden></section>' +
          '<section><button type="button">Nearby file</button><input id="nearby-file" type="file" hidden></section>' +
          '<section><button type="button">Ambiguous file</button><input type="file" hidden><input type="file" hidden></section>' +
          '<form><button type="button">Associated file</button><input id="associated-file" type="file" hidden></form>' +
          '<section><button onclick="document.getElementById(\'multi-file\').click()">Multiple files</button><input id="multi-file" type="file" multiple hidden></section>',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const first = createElectronHost({
      partition: 'persist:external-one',
      autofillPreload: join(profile, 'empty-preload.cjs'),
      failurePage: () => 'about:blank',
      blockedDownload: (name) => `Blocked: ${name}`,
    })
    const second = createElectronHost({
      partition: 'persist:external-two',
      autofillPreload: join(profile, 'empty-preload.cjs'),
      failurePage: () => 'about:blank',
      blockedDownload: (name) => `Blocked: ${name}`,
    })
    const cipher = {
      available: () => true,
      encrypt: (plain: string) => Buffer.from(plain).toString('base64'),
      decrypt: (sealed: string) => Buffer.from(sealed, 'base64').toString(),
    }
    const state = await restoreBrowserCookies({
      partition: 'persist:external-one',
      file: join(profile, 'own-cookies.enc'),
      cipher,
    })
    const { driver } = createCdpDriver({
      hostId: 'fixture',
      host: first,
      sites: createSiteBook(null),
      onChange: first.onChange,
    })
    const scope = { hostId: 'fixture', deviceId: 'd', sessionId: 's', turnId: 't', callId: 'c' }
    const operation = { scope, signal: new AbortController().signal }
    const id = await driver.open(scope, { kind: 'agent', keep: false }, operation)
    assert.deepEqual(await driver.navigate(id, url, 10000, operation), { ok: true })
    const snapshot = await driver.snapshot(id, false, operation)
    assert.match(snapshot.text, /Owned fixture/)
    await driver.act(snapshot.observation, { kind: 'press', key: 'Tab' }, operation)
    // 只用虚构值验真实 password/验证码/支付输入框；类型规则不应替任务授权增加限制。
    for (const [field, label, text] of [
      ['password', 'Nebula password', 'example-nebula-secret'],
      ['code', 'Nebula code', '123456'],
      ['card', 'Nebula card', '4111111111111111'],
    ]) {
      const observed = await driver.snapshot(id, false, operation)
      const line = observed.text
        .split('\n')
        .find((line) => line.includes(`"${label}"`) && line.includes('[ref='))
      const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1]
      assert.ok(ref, `${label} 必须能获得输入引用`)
      await driver.act(
        observed.observation,
        { kind: 'type', target: { kind: 'element', ref }, text, clear: true, submit: false },
        operation,
      )
      const page = first.page(id)
      assert.ok(page)
      const result = await page.cdp<{ result: { value: boolean } }>('Runtime.evaluate', {
        expression: `document.getElementById(${JSON.stringify(field)}).value === ${JSON.stringify(text)}`,
        returnByValue: true,
      })
      assert.equal(result.result.value, true, `${label} 必须实际收到输入`)
    }
    // 真实 CDP 复现商店隐藏文件框，以及点击后动态创建文件框；不修改页面样式。
    const executor = createBrowserExecutor({ host: first, sites: createSiteBook(null) })
    const fixtureFile = join(profile, 'chooser-fixture.txt')
    writeFileSync(fixtureFile, 'chooser fixture 中文')
    let callId = 0
    const call = (tool: string, args: Record<string, unknown> = {}) =>
      executor.call(
        {
          id: `upload-${++callId}`,
          callId: String(callId),
          namespace: 'litch_browser',
          tool,
          threadId: 'upload-session',
          turnId: 'upload-turn',
          arguments: args,
          device: { id: 'local', name: 'fixture', kind: 'local', target: null },
          harness: null,
          cwd: null,
        },
        { signal: new AbortController().signal, ask: async () => 'once' },
      )
    const text = (reply: Awaited<ReturnType<typeof call>>) =>
      reply.contentItems.map((i) => (i.type === 'inputText' ? i.text : '')).join('\n')
    assert.equal((await call('navigate', { url })).success, true)
    let observed = text(await call('snapshot'))
    assert.match(observed, /file input "hidden-file" hidden.*ref=/)
    for (const [label, id] of [
      ['Select file', 'hidden-file'],
      ['Dynamic file', 'dynamic-file'],
      ['Label file', 'label-file'],
      ['Associated file', 'associated-file'],
      ['Label fallback', 'fallback-file'],
      ['Nearby file', 'nearby-file'],
      ['Multiple files', 'multi-file'],
    ]) {
      observed = text(await call('snapshot'))
      const ref = observed
        .split('\n')
        .find((line) => line.includes(`button "${label}"`))
        ?.match(/\[ref=([^\]]+)\]/)?.[1]
      assert.ok(ref, observed)
      const uploadPage = first.page(executor.currentTab('local', 'upload-session') ?? '')
      assert.ok(uploadPage?.interceptFileChooser)
      const intercept = uploadPage.interceptFileChooser.bind(uploadPage)
      let chooserObserved = false
      uploadPage.interceptFileChooser = async (signal) => {
        const watch = await intercept(signal)
        return {
          ...watch,
          wait: async (timeout) => {
            const event = await watch.wait(timeout)
            chooserObserved = !!event?.backendNodeId
            return event
          },
        }
      }
      const reply = await call('upload', {
        ref,
        paths: label === 'Multiple files' ? [fixtureFile, fixtureFile] : [fixtureFile],
      })
      uploadPage.interceptFileChooser = intercept
      assert.equal(reply.success, true, text(reply))
      assert.equal(
        chooserObserved,
        !['Associated file', 'Label fallback', 'Nearby file'].includes(label),
        `必须观察到 ${label} 的实际选择器事件`,
      )
      const result = await call('evaluate', {
        expression: `(()=>{const f=document.getElementById(${JSON.stringify(id)});return {names:Array.from(f.files,x=>x.name),hidden:!f.checkVisibility({checkVisibilityCSS:true})}})()`,
      })
      assert.match(text(result), /chooser-fixture.txt/)
      assert.match(text(result), /"hidden":true/)
      if (label === 'Select file') {
        const rejected = await call('upload', { ref, paths: [fixtureFile, fixtureFile] })
        assert.equal(rejected.success, false)
        assert.match(text(rejected), /only one file/)
      }
    }
    observed = text(await call('snapshot'))
    const hiddenRef = observed
      .split('\n')
      .find((line) => line.includes('file input "hidden-file"'))
      ?.match(/\[ref=([^\]]+)\]/)?.[1]
    assert.ok(hiddenRef)
    assert.equal((await call('upload', { ref: hiddenRef, paths: [fixtureFile] })).success, true)
    const wrongFile = join(profile, 'rejected.zip')
    writeFileSync(wrongFile, 'fixture')
    const rejectedType = await call('upload', { ref: hiddenRef, paths: [wrongFile] })
    assert.equal(rejectedType.success, false)
    assert.match(text(rejectedType), /accept=/)
    const ambiguousRef = observed
      .split('\n')
      .find((line) => line.includes('button "Ambiguous file"'))
      ?.match(/\[ref=([^\]]+)\]/)?.[1]
    assert.ok(ambiguousRef)
    const ambiguous = await call('upload', { ref: ambiguousRef, paths: [fixtureFile] })
    assert.equal(ambiguous.success, false)
    assert.match(text(ambiguous), /Ambiguous upload target/)
    console.log('BROWSER_UPLOAD_CHOOSER_OK hidden/dynamic/label/associated/multiple')
    const afterTyping = await driver.snapshot(id, false, operation)
    assert.equal(
      afterTyping.text.includes('example-nebula-secret'),
      false,
      '允许填写不改变密码观察遮罩',
    )
    await session
      .fromPartition('persist:external-one')
      .cookies.set({ url, name: 'isolated', value: 'fixture' })
    assert.equal(
      (await session.fromPartition('persist:external-two').cookies.get({ url })).length,
      0,
    )
    assert.equal((await session.defaultSession.cookies.get({ url })).length, 0)
    await state.flush()
    assert.equal(first.page(id)?.info().url, `${url}/`)
    assert.equal(session.fromPartition('persist:external-two').getPreloads().length, 0)
    await first.clearData()
    assert.equal(
      (await session.fromPartition('persist:external-one').cookies.get({ url })).length,
      0,
    )
    await driver.dispose()
    state.dispose()
    first.dispose()
    second.dispose()
    assert.throws(() => first.open({ deviceId: 'd', threadId: 's' }, 'agent'), /disposed/)
    server.close()
    console.log('BROWSER_PACKAGE_ELECTRON_OK')
    console.log('BROWSER_AUTHORIZED_CREDENTIAL_INPUT_OK')
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
