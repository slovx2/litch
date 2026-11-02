import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installTerminalAudit, terminalEvidence } from '../scripts/terminal-audit.mjs'

for (const shell of process.platform === 'darwin' ? ['/bin/bash', '/bin/zsh'] : ['/bin/bash']) {
  test(`终端探针 ${shell} 记录就绪、未展开命令和精确文件`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'litch-terminal-audit-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const work = join(root, 's', 'work')
    mkdirSync(work, { recursive: true })
    const config = { root, work }
    installTerminalAudit(config)
    const command = 'echo e2e-$((6*7)) > e2e-mark.txt'
    const result = spawnSync(shell, ['-i'], {
      input: `${command}\nexit\n`,
      cwd: work,
      env: { PATH: '/usr/bin:/bin', HOME: join(root, 's'), ZDOTDIR: join(root, 's') },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(work, 'e2e-terminal-ready.txt'), 'utf8'), 'ready\n')
    const evidence = terminalEvidence(config, root)
    assert.ok(evidence.commands.split('\n').includes(command), evidence.commands)
    assert.equal(evidence.file, 'e2e-42\n')
    assert.throws(() => installTerminalAudit({ root, work: tmpdir() }))
  })
}
