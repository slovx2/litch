// Windows 的名单（policy-win.mts）和按平台分派（policy.mts）。
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { classifyApp } from '../policy.mjs'
import { classifyWinApp, exeName, WIN_BASELINE } from '../policy-win.mjs'

const exe = (path: string, name = 'App') => classifyWinApp({ appId: path, name, exe: path })

test('助手底线名单里的每一项主进程这份都禁止', () => {
  assert.deepEqual([...WIN_BASELINE].sort(), [
    'consent.exe',
    'credentialuibroker.exe',
    'litch-computer-use.exe',
    'litch.exe',
    'lockapp.exe',
    'logonui.exe',
  ])
  for (const name of WIN_BASELINE) {
    assert.equal(exe(`C:\\Windows\\System32\\${name}`), 'forbidden', name)
  }
})

test('助手那份 baseline.rs 在的话，里面列的 exe 这边都禁止', () => {
  // 乙线的助手合进来之后才有；没有就跳过
  const root = process.env.LITCH_DESKTOP_ROOT
  if (!root) return
  const file = join(root, '..', 'computer-use-win', 'src', 'baseline.rs')
  if (!existsSync(file)) return
  // 只看底线名单那一段（FORBIDDEN_EXES）；同一文件里的外壳名单是“不列为应用”，不是禁止
  const block = /FORBIDDEN_EXES[^=]*=\s*&\[([\s\S]*?)\];/.exec(readFileSync(file, 'utf8'))?.[1]
  assert.ok(block, 'baseline.rs 里找不到 FORBIDDEN_EXES')
  const names = [...block.matchAll(/"([\w.-]+\.exe)"/gi)].map((match) =>
    (match[1] ?? '').toLowerCase(),
  )
  assert.ok(names.length > 0, 'FORBIDDEN_EXES 是空的')
  for (const name of names) assert.equal(exe(name), 'forbidden', `baseline.rs 里的 ${name}`)
})

test('禁止：系统设置、管理工具、任务管理器、安全软件、密码管理器、官方桌面端', () => {
  for (const path of [
    'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe',
    'C:\\Windows\\System32\\control.exe',
    'C:\\Windows\\regedit.exe',
    'C:\\Windows\\System32\\mmc.exe',
    'C:\\Windows\\System32\\Taskmgr.exe',
    'C:\\Program Files\\Windows Defender\\MSASCuiL.exe',
    'C:\\Program Files\\1Password\\app\\8\\1Password.exe',
    'C:\\Program Files\\Bitwarden\\Bitwarden.exe',
    'C:\\Program Files\\KeePassXC\\KeePassXC.exe',
    'C:\\Users\\me\\AppData\\Local\\Programs\\Litch\\Litch.exe',
  ]) {
    assert.equal(exe(path), 'forbidden', path)
  }
  // 打包应用按 AUMID
  for (const aumid of [
    'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel',
    'Microsoft.SecHealthUI_8wekyb3d8bbwe!SecHealthUI',
    'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT',
    'AgileBits.1Password_amwd9z03whsfe!1Password',
  ]) {
    assert.equal(classifyWinApp({ appId: aumid, name: 'x', aumid }), 'forbidden', aumid)
  }
})

test('改了文件名也认得出（OriginalFilename）；显示名里带“密码”的也禁止', () => {
  assert.equal(
    classifyWinApp({
      appId: 'C:\\tools\\notes.exe',
      name: 'Notes',
      exe: 'C:\\tools\\notes.exe',
      originalFilename: 'Taskmgr.exe',
    }),
    'forbidden',
  )
  assert.equal(exe('C:\\x\\vault.exe', 'My Password Vault'), 'forbidden')
  assert.equal(exe('C:\\x\\mm.exe', '密码本'), 'forbidden')
})

test('高风险：浏览器、终端、资源管理器、脚本宿主；其余普通', () => {
  for (const path of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\Git\\usr\\bin\\mintty.exe',
    'C:\\Windows\\explorer.exe',
    'C:\\Windows\\System32\\wscript.exe',
  ]) {
    assert.equal(exe(path), 'elevated', path)
  }
  assert.equal(
    classifyWinApp({
      appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
      name: 'Terminal',
      aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
      exe: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\WindowsTerminal.exe',
    }),
    'elevated',
  )
  assert.equal(
    classifyWinApp({
      appId: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App',
      name: 'Notepad',
      aumid: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App',
      exe: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad\\Notepad\\Notepad.exe',
    }),
    'normal',
  )
  assert.equal(exe('C:\\Program Files\\Paint.NET\\paintdotnet.exe'), 'normal')
})

test('exe 文件名：两种斜杠、大小写；按平台分派', () => {
  assert.equal(exeName('C:\\A\\B\\Foo.EXE'), 'foo.exe')
  assert.equal(exeName('C:/A/foo.exe'), 'foo.exe')
  assert.equal(exeName(null), '')
  assert.equal(
    classifyApp({ platform: 'win32', appId: 'C:\\Windows\\regedit.exe', name: 'Registry Editor' }),
    'forbidden',
  )
  assert.equal(
    classifyApp({ platform: 'darwin', bundleId: 'com.apple.Terminal', name: 'Terminal' }),
    'elevated',
  )
  // macOS 的名单不认 Windows 的 exe，反过来也一样
  assert.equal(classifyApp({ platform: 'darwin', bundleId: null, name: 'regedit.exe' }), 'normal')
})
