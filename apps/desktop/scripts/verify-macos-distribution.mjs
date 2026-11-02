// 验的是最终 dmg 与更新 zip，不用构建目录的检查代替用户收到的文件。
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditWritable } from '../../../scripts/adapter-stage.mjs'
import { validateTicket } from './notarize.mjs'
import { OUT_DIR } from './packed.mjs'

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit', timeout: 120_000 })
const installer = join(OUT_DIR, 'installer')
const unique = (suffix) => {
  const files = readdirSync(installer).filter((file) => file.endsWith(suffix))
  if (files.length !== 1) throw new Error(`必须恰有一份 ${suffix}`)
  return join(installer, files[0])
}
const signed = Boolean(process.env.LITCH_SIGN_IDENTITY)
const temp = mkdtempSync(join(tmpdir(), 'litch-distribution-'))
const mounted = join(temp, 'image')
let attached = false
const checkApp = (app, requireTicket) => {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  auditWritable(app)
  if (signed) {
    if (requireTicket) validateTicket(app)
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
  }
}
try {
  const dmg = unique('.dmg')
  if (signed) {
    validateTicket(dmg)
    run('spctl', [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=2',
      dmg,
    ])
  }
  run('hdiutil', ['verify', dmg])
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mounted, dmg])
  attached = true
  // dmg 的票钉在最外层；不修改已经公证的磁盘映像。复制出来再核对可写权限。
  const fromImage = join(temp, 'dmg', 'Litch.app')
  run('ditto', [join(mounted, 'Litch.app'), fromImage])
  checkApp(fromImage, false)
  const extracted = join(temp, 'zip')
  run('ditto', ['-xk', unique('.zip'), extracted])
  // zip 无法直接 staple，它内含的 App 必须带票，且保持 ShipIt 所需的所有者可写权限。
  checkApp(join(extracted, 'Litch.app'), true)
} finally {
  if (attached) run('hdiutil', ['detach', mounted])
  rmSync(temp, { recursive: true, force: true })
}
