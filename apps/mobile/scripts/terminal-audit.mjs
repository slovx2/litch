import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`

/** 只给隔离夹具的 shell 装探针，不接触登录用户的启动文件。 */
export function installTerminalAudit(config) {
  const home = join(config.root, 's')
  if (resolve(config.work) !== resolve(home, 'work')) throw new Error('终端探针只支持夹具工作目录')
  const ready = quote(join(config.work, 'e2e-terminal-ready.txt'))
  const commands = quote(join(config.work, 'e2e-shell-commands.txt'))
  const mark = `printf 'ready\n' > ${ready}\n`
  const trace = `printf "%s\\n" "$BASH_COMMAND" >> ${commands}`
  const bash = `trap ${quote(trace)} DEBUG\n${mark}`
  writeFileSync(join(home, '.bashrc'), bash)
  writeFileSync(join(home, '.bash_profile'), `. ${quote(join(home, '.bashrc'))}\n`)
  writeFileSync(join(home, '.zshrc'), `preexec() { print -r -- "$1" >> ${commands}; }\n${mark}`)
}

/** shell 的实际解释命令与最终文件分别取证；不是 PTY 逐字节捕获。 */
export function terminalEvidence(config, directory) {
  const read = (name) => {
    const file = join(config.work, name)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }
  const evidence = {
    at: new Date().toISOString(),
    commands: read('e2e-shell-commands.txt'),
    file: read('e2e-mark.txt'),
  }
  appendFileSync(join(directory, 'terminal-evidence.jsonl'), `${JSON.stringify(evidence)}\n`)
  return evidence
}
