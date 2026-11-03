import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  blockedBy,
  cleanReal,
  expandPath,
  expandRules,
  flaggedIn,
  foldCase,
  inside,
  parentOf,
} from '../src/device/machine/paths.mjs'
import { sensitivePresets } from '../src/device/machine/presets.mjs'
import { execCommand, parseListed, parseProbe, scriptsFor } from '../src/device/machine/scripts.mjs'
import {
  powershellCommand,
  windowsExec,
  windowsScripts,
} from '../src/device/machine/scripts-windows.mjs'
import { windowsCopyPath } from '../src/device/machine/windows-paths.mjs'

const home = 'C:\\Users\\小明'
const script = (argv: readonly string[]): string =>
  Buffer.from(argv.at(-1) ?? '', 'base64').toString('utf16le')

test('跨系统复制：Windows 不可用的源文件名不能变成盘外路径或覆盖别名', () => {
  for (const relative of [
    '../secret',
    '..\\secret',
    'a/b:stream',
    'NUL',
    'file.',
    'file ',
    '/outside',
    'a\\b',
  ])
    assert.equal(windowsCopyPath('C:/work', relative), null, relative)
  assert.equal(windowsCopyPath('C:/', '中文/a.txt'), 'C:/中文/a.txt')
  assert.equal(windowsCopyPath('//host/share/', '目录/文件'), '//host/share/目录/文件')
})

test('Windows 路径：盘符、UNC、反斜杠、..、根目录与保留名', () => {
  for (const [input, expected] of [
    ['~\\项目\\a.txt', 'C:/Users/小明/项目/a.txt'],
    ['c:\\work\\..\\文件.txt', 'C:/文件.txt'],
    ['C:/../../a', 'C:/a'],
    ['C:\\', 'C:/'],
    ['\\\\server\\share\\目录\\..\\文件', '//server/share/文件'],
    ['//server/share/../../x', '//server/share/x'],
    ['C:/Users/小明/.ssh. /key', 'C:/Users/小明/.ssh/key'],
  ])
    assert.equal(expandPath(input as string, home), expected)
  for (const input of [
    'C:relative',
    '\\relative',
    '/relative',
    '\\\\?\\C:\\x',
    '\\\\.\\pipe\\x',
    'C:/a:stream',
    'C:/nul.txt',
    'C:/COM1',
    'C:/bad\0name',
    '//server:/share/file',
    '//server',
  ])
    assert.equal(expandPath(input, home), null, input)
  assert.equal(parentOf('C:/file'), 'C:/')
  assert.equal(parentOf('//server/share/file'), '//server/share/')
  assert.equal(parentOf('C:/'), 'C:/')
  assert.equal(cleanReal('c:\\x\\y'), 'C:/x/y')
})

test('Windows 访问范围：大小写、路径边界、整个盘或共享、解析后的 junction', () => {
  assert.equal(foldCase('Windows 11 x64'), true)
  assert.equal(foldCase('Linux x86_64'), false)
  const expanded = expandRules(['~/.ssh', 'D:\\', '\\\\server\\share'], home)
  const rules = expanded.map((one) => ({ ...one, real: one.expanded }))
  assert.equal(blockedBy('c:/users/小明/.SSH/id_rsa', rules, true)?.rule, '~/.ssh')
  assert.equal(blockedBy('C:/Users/小明/.sshx/file', rules, true), null)
  assert.equal(blockedBy('d:/key', rules, true)?.rule, 'D:\\')
  assert.equal(blockedBy('//SERVER/SHARE/file', rules, true)?.rule, '\\\\server\\share')
  assert.equal(inside('//server/share/', '//server/else/file', true), false)
  assert.equal(
    blockedBy(
      'D:/keys/private',
      [{ rule: '~/.ssh', expanded: 'C:/Users/小明/.ssh', real: 'D:/keys' }],
      true,
    )?.rule,
    '~/.ssh',
  )
})

test('Windows 敏感名单与命令标记使用实际 AppData，三个环境变量写法都能认', () => {
  const facts = { system: 'Windows 11', appData: 'D:\\用户配置', localAppData: 'E:\\本地配置' }
  const denied = sensitivePresets(facts)
  for (const rule of [
    '~/.ssh',
    'D:/用户配置/Microsoft/Protect',
    'E:/本地配置/Microsoft/Credentials',
    'E:/本地配置/Google/Chrome/User Data',
    '~/.codex',
    '~/.claude',
    'D:/用户配置/opencode',
  ])
    assert.ok(denied.includes(rule), rule)
  assert.equal(
    denied.some((one) => one.includes('Library/')),
    false,
  )
  const rules = expandRules(denied, home).map((one) => ({ ...one, real: one.expanded }))
  for (const command of [
    'Get-Content $env:USERPROFILE\\.SSH\\id_rsa',
    'cat "${env:USERPROFILE}/.ssh/id_rsa"',
    'cmd /c type %USERPROFILE%\\.ssh\\id_rsa',
    'cat C:\\Users\\小明\\.ssh\\id_rsa',
  ])
    assert.deepEqual(flaggedIn(command, cleanReal(home), home, rules, true, facts), ['~/.ssh'])
  assert.deepEqual(
    flaggedIn('ls $env:APPDATA\\Microsoft\\Protect', cleanReal(home), home, rules, true, facts),
    ['D:/用户配置/Microsoft/Protect'],
  )
  assert.deepEqual(flaggedIn('cat ~/.sshx/key', cleanReal(home), home, rules, true, facts), [])
})

test('Windows 命令：UTF-16LE 参数完整保留中文、引号、美元、换行，不经过 cmd', () => {
  const original = `Write-Output '中文😀'; $x = "$HOME"\r\nWrite-Output $x`
  assert.equal(script(powershellCommand(original)), original)
  const argv = execCommand('', original, 'Windows 11')
  assert.equal(argv[0], 'powershell.exe')
  assert.ok(argv.includes('-NoProfile'))
  assert.match(script(argv), /UTF8Encoding/)
  assert.ok(script(argv).includes(original.replaceAll("'", "''")))
  assert.equal(execCommand('/bin/zsh', 'pwd', 'macOS')[0], '/bin/sh')
  const path = `C:/中文/a';throw 'injected.txt`
  assert.ok(
    script(windowsScripts.probe(path, [])).includes("$path = 'C:/中文/a'';throw ''injected.txt'"),
  )
  assert.equal(scriptsFor('C:/x'), windowsScripts)
  assert.equal(scriptsFor('//server/share/x'), windowsScripts)
  assert.throws(() => windowsScripts.signal('SIGINT', 123), /action kill/)
})

// 同一个测试文件带到 Windows 后运行，验证真实 PowerShell 与 Win32 文件语义；Mac 上只跳过这一项。
test('Windows 真脚本：中文、字节范围、追加、junction、目录裁剪和命令退出码', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-machine-中文 '))
  const run = (argv: string[], input?: Buffer): Buffer => {
    const result = spawnSync(argv[0] as string, argv.slice(1), {
      input,
      windowsHide: true,
      timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr?.toString() || String(result.error))
    return result.stdout
  }
  const probe = (path: string, denied: string[] = []) =>
    parseProbe(
      run(windowsScripts.probe(path, denied)).toString('utf8').split('\0').slice(0, -1),
      denied.length,
    )
  try {
    mkdirSync(join(root, '机密'))
    writeFileSync(join(root, '机密', '凭据.txt'), '不要泄露')
    symlinkSync(join(root, '机密'), join(root, '联接'), 'junction')
    const resolved = probe(join(root, '联接', '凭据.txt'), [join(root, '机密')])
    assert.equal(resolved.type, 'f')
    assert.equal(resolved.size, Buffer.byteLength('不要泄露'))
    assert.equal(inside(resolved.denied[0] as string, resolved.real, true), true)
    assert.equal(probe(join(root, '联接', '不存在', '新文件')).type, 'm')
    const file = join(root, "a'中文.txt")
    run(windowsScripts.write(file), Buffer.from('中文\r\n'))
    run(windowsScripts.append(file), Buffer.from('追加\n'))
    assert.deepEqual(readFileSync(file), Buffer.from('中文\r\n追加\n'))
    assert.deepEqual(run(windowsScripts.readRange(file, 3, 5)), Buffer.from('文\r\n'))
    const rows = run(windowsScripts.list(root, null, true, [cleanReal(join(root, '机密'))]))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map(parseListed)
    assert.ok(rows.some((one) => one?.type === 'l'))
    assert.equal(
      rows.some((one) => one?.path.endsWith('/凭据.txt')),
      false,
    )
    assert.match(run(windowsExec("Write-Output '中文输出😀'")).toString('utf8'), /中文输出😀/)
    assert.equal(spawnSync(...commandTuple(windowsExec('exit 7')), { windowsHide: true }).status, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const commandTuple = (argv: string[]): [string, string[]] => [argv[0] as string, argv.slice(1)]
