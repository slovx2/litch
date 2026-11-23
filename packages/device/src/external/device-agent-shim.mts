import { fileURLToPath } from 'node:url'
import { shellQuoteGithubHelper } from './secrets-agent-helper.mjs'

export function agentCommandShim(directory: string, mode: 'git' | 'gh', adapter: string): string {
  const cli = fileURLToPath(new URL('./device-agent-command.mjs', import.meta.url))
  const command = [adapter, 'agent-command', directory, process.execPath, cli, mode]
  return process.platform === 'win32'
    ? `@echo off\r\n${command.map((value) => `"${value.replaceAll('%', '%%')}"`).join(' ')} %*\r\n`
    : `#!/bin/sh\nexec ${command.map(shellQuoteGithubHelper).join(' ')} "$@"\n`
}
