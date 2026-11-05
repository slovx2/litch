// 在已安装开发包的专用 iOS 模拟器上复用 Android 的产品断言；不碰用户真机。
// 用法：node scripts/check-ios.mjs <simulator-udid> <fixture.json> mock/01-home.yaml ...
// 保留产品断言，替换开发包与深链，并处理 iOS 首次打开深链的系统确认。临时报告退出时删除。
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { iosTestHelper } from './ios-test-helper.mjs'
import { installTerminalAudit } from './terminal-audit.mjs'

const mobile = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [simulator, configPath, ...flows] = process.argv.slice(2)
if (!simulator || !configPath || !flows.length)
  throw new Error('需要专用模拟器 UDID、夹具配置和流程列表')
const devices = JSON.parse(
  execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], { encoding: 'utf8' }),
)
const device = Object.values(devices.devices)
  .flat()
  .find((entry) => entry.udid === simulator)
if (!device?.name.startsWith('Litch-iOS-')) throw new Error('仅允许 Litch-iOS- 命名的隔离模拟器')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const base = join(mobile, '.artifacts')
mkdirSync(base, { recursive: true })
const artifacts = mkdtempSync(join(base, 'ios-validation-'))
const helper = await iosTestHelper(config, artifacts, simulator)
let child
let stopping = false
let locked = false
const cleanup = async () => {
  if (stopping) return
  stopping = true
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }
  try {
    await helper.stop()
    rmSync(artifacts, { recursive: true })
  } finally {
    if (locked) {
      if (existsSync('/tmp/litch-maestro-7001.lock/owner'))
        unlinkSync('/tmp/litch-maestro-7001.lock/owner')
      rmdirSync('/tmp/litch-maestro-7001.lock')
      locked = false
    }
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void cleanup().then(() => process.exit(130))
  })

try {
  const confirmLink = (indent = '') =>
    `${indent}- runFlow:\n${indent}    when:\n${indent}      visible: '.*(在.*Litch Dev.*中打开|Open in.*Litch Dev).*'\n${indent}    commands:\n${indent}      - tapOn: '^(打开|Open)$'`
  const copy = (source, target) => {
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      if (entry.isDirectory()) copy(from, to)
      else
        writeFileSync(
          to,
          readFileSync(from, 'utf8')
            .replace(/dev\.litch\.app(?!\.dev)/g, 'dev.litch.app.dev')
            .replaceAll('litch://', 'litch-dev://')
            // 两个开关已完整可见，但靠近列表边界，iOS 倒置列表无法把它们都居中。
            // 保留 100% 可见与 checked 断言，只取消强制居中。
            .replace(/^ {4}centerElement: true$/gm, (line) =>
              entry.name === '15-worktrees.yaml' ? '    centerElement: false' : line,
            )
            // 会话行是单个无障碍按钮，分支文字在该行标签中；后续的分支值断言保持原样。
            .replaceAll('id: session:s5:worktree', 'id: session:s5')
            // iOS 只暴露整个图像按钮；它仅在 SVG/PNG 生成后启用，不能用仍在绘制的容器充数。
            .replace(
              /^( *)id: mermaid-card:image$/gm,
              (_, indent) => `${indent}id: mermaid-card:open\n${indent}enabled: true`,
            )
            // iOS 把可点击 Row 的标题与详情合并；仍严格验证选中的起点控件及完整分支名。
            .replace(
              '- assertVisible:\n    text: release/0.18\n',
              '- assertVisible:\n    id: new:from\n    text: "^(From|起点), release/0\\\\.18$"\n',
            )
            .replace(
              'text: .*(Worktree|工作树)[:：] litch/.*',
              'text: "(?s).*(Worktree: |工作树：)litch/.*"',
            )
            // 原生元素点击验证这些动作正常；iOS 滚动结束前的旧坐标会点到相邻控件。
            .replace(
              /^( *)- tapOn:\n\1 {4}id: (hc:attempt:\.\*:code|proposal:e2e-pr1:more|hc:models:add)\n/gm,
              (line, indent) =>
                `${indent}- waitForAnimationToEnd:\n${indent}    timeout: 3000\n${line}`,
            )
            // 填主机后键盘盖住用户名；像 XCTest 的元素点击一样，先把目标滚入可见区域。
            .replace(
              '- tapOn:\n    id: add:user\n',
              '- scrollUntilVisible:\n    element:\n      id: add:user\n    centerElement: true\n' +
                '- waitForAnimationToEnd:\n    timeout: 3000\n- tapOn:\n    id: add:user\n',
            )
            // iOS 的整句 XCTest 注入会产生虚拟 keyCode，终端按真实逐字输入验证。
            .replace(
              '- inputText: echo e2e-$((6*7)) > e2e-mark.txt',
              '- evalScript: ${output.terminalCommand = "echo e2e-$((6*7)) > e2e-mark.txt"; output.terminalAt = 0}\n' +
                '- repeat:\n    while:\n      true: ${output.terminalAt < output.terminalCommand.length}\n' +
                '    commands:\n      - inputText: ${output.terminalCommand.charAt(output.terminalAt)}\n' +
                '      - evalScript: ${output.terminalAt += 1}',
            )
            .replace(
              '- tapOn:\n    id: pair:paste\n- inputText: ${output.pairText}\n- hideKeyboard',
              '- runScript: ../ios/pair-clipboard.js\n- assertTrue: ${output.clipboardSet}\n' +
                '- tapOn: "从剪贴板粘贴|Paste from clipboard"\n' +
                '- runFlow:\n    when:\n      visible: "允许粘贴|Allow Paste"\n' +
                '    commands:\n      - tapOn: "允许粘贴|Allow Paste"',
            )
            // iOS 没有系统返回键，用同一个页面的返回或关闭按钮。
            .replace('- back\n- back\n', (steps) =>
              entry.name === '15-worktrees.yaml'
                ? '- tapOn:\n    id: worktree:scrim\n- back\n'
                : steps,
            )
            .replace(
              /^( *)- back$/gm,
              (_, indent) =>
                `${indent}- tapOn:\n${indent}    id: ${entry.name === '16-mermaid.yaml' ? 'mermaid-viewer:close' : 'header:back'}`,
            )
            .replace('    stopApp: true\n', () => `    stopApp: true\n${confirmLink()}\n`)
            .replace(
              /^( *)- openLink: (.+)$/gm,
              (line, indent) => `${line}\n${confirmLink(indent)}`,
            )
            // iOS 数字/多行键盘不一定有系统收起动作，使用产品统一的完成按钮并验证已收起。
            .replace(
              /^( *)- hideKeyboard[ \t]*$/gm,
              (_, indent) =>
                `${indent}- tapOn:\n${indent}    id: keyboard:done\n` +
                `${indent}- extendedWaitUntil:\n${indent}    notVisible:\n${indent}      id: keyboard:done\n${indent}    timeout: 5000`,
            ),
        )
    }
  }
  copy(join(mobile, 'e2e/flows'), join(artifacts, 'flows'))
  copy(join(mobile, 'e2e/ios'), join(artifacts, 'flows/ios'))
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@localhost', ...args], {
      cwd: config.work,
      stdio: 'ignore',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    })
  if (!existsSync(join(config.work, '.git'))) {
    writeFileSync(join(config.work, 'README.md'), '# e2e\n\n第一行\n第二行\n')
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    writeFileSync(join(config.work, 'README.md'), '# e2e\n\n第一行\n改过的第二行\n')
    writeFileSync(join(config.work, 'notes.txt'), 'e2e 新加的文件\n')
  }
  installTerminalAudit(config)
  const env = {
    ADAPTER: config.adapter,
    FX_MODE: 'svc',
    FIXTURE_PORT: String(config.target.port),
    FIXTURE_USER: config.target.user,
    PORT: String(config.target.port),
    USER: config.target.user,
    KEY: config.target.privateKey,
    FINGERPRINT_RE: config.target.hostFingerprint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    WORK: config.work,
    HELPER: helper.url,
    HELPER_PORT: new URL(helper.url).port,
  }
  const args = [
    '--udid',
    simulator,
    'test',
    '--no-ansi',
    '--test-output-dir',
    artifacts,
    '--debug-output',
    artifacts,
  ]
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`)
  while (!locked) {
    try {
      mkdirSync('/tmp/litch-maestro-7001.lock')
      locked = true
      writeFileSync(
        '/tmp/litch-maestro-7001.lock/owner',
        `mobile-ios PID=${process.pid} started=${new Date().toISOString()}\n`,
      )
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      console.log('等待其他手机线释放 Maestro 7001；30 秒后重试。')
      await sleep(30_000)
    }
  }
  for (const flow of flows) {
    if (stopping) break
    if (!/^(mock|fixture|ios)\/[\w-]+\.yaml$/.test(flow)) throw new Error(`无效流程：${flow}`)
    // 终端可能复用还活着的 shell；每条流程只认这一轮新执行的命令和产物。
    writeFileSync(join(config.work, 'e2e-shell-commands.txt'), '')
    const mark = join(config.work, 'e2e-mark.txt')
    if (existsSync(mark)) unlinkSync(mark)
    if (flow === 'ios/terminal-paste.yaml')
      execFileSync('xcrun', ['simctl', 'pbcopy', simulator], {
        input: 'echo e2e-$((6*7)) > e2e-mark.txt',
      })
    console.log(`iOS 验收开始：${flow}`)
    child = spawn(process.env.MAESTRO ?? 'maestro', [...args, join(artifacts, 'flows', flow)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ''} -Djava.net.preferIPv4Stack=true`,
      },
    })
    const running = child
    let expired = false
    let force
    // 驱动返回 500 后 JVM 可能仍不退出；保留失败并释放共享锁，不能无限挂住后续验收。
    const deadline = setTimeout(() => {
      expired = true
      console.error(`iOS 验收超时：${flow}`)
      running.kill('SIGTERM')
      force = setTimeout(() => running.kill('SIGKILL'), 10_000)
      force.unref()
    }, 10 * 60_000)
    deadline.unref()
    const result = await new Promise((resolve, reject) => {
      // 不把包含临时私钥的完整 spawnargs 打进启动失败日志。
      running.on('error', (error) => reject(new Error(error.message)))
      running.on('exit', resolve)
    }).finally(() => {
      clearTimeout(deadline)
      clearTimeout(force)
    })
    const code = expired ? 124 : result
    console.log(`iOS 验收结果：${flow} ${code === 0 ? '通过' : '失败'}`)
    if (code !== 0) {
      process.exitCode = code ?? 1
      // 清理临时报告前留下失败页的控件标签；不输出输入值或密钥文本。
      const reports = readdirSync(artifacts, { recursive: true }).filter((name) =>
        name.endsWith(`commands-(${flow.split('/').at(-1)}).json`),
      )
      for (const report of reports) {
        const commands = JSON.parse(readFileSync(join(artifacts, report), 'utf8'))
        const labels = new Set()
        const walk = (node) => {
          const attr = node.attributes ?? {}
          const id = attr['resource-id'] ?? ''
          const label = attr.accessibilityText ?? ''
          if ((id || label) && !id.startsWith('key:') && !label.includes('PRIVATE KEY'))
            labels.add(`${id} ${label}`.trim().slice(0, 180))
          if (/^proposal:.*:worktree$/.test(id))
            labels.add(
              JSON.stringify({
                id,
                checked: attr.checked,
                selected: attr.selected,
                value: ['0', '1'].includes(attr.value) ? attr.value : undefined,
                bounds: attr.bounds,
              }),
            )
          for (const entry of node.children ?? []) walk(entry)
        }
        for (const entry of commands)
          if (entry.metadata?.error?.hierarchyRoot) walk(entry.metadata.error.hierarchyRoot)
        console.log('失败页控件：', [...labels].slice(0, 100).join('\n'))
      }
    }
  }
} finally {
  await cleanup()
}
