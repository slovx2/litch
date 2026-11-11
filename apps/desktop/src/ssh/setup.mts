import { randomBytes } from 'node:crypto'
import {
  type AbortSignalLike,
  installBlocked,
  type RemoteSetupPlatform,
  readInstall,
} from '@litch/core'
import { startPeer } from './probe.mjs'
import { fields, runRemote, tailOf } from './run.mjs'
import { type RemoteLang, setupScript } from './script.mjs'

/** 仅首次安装：不执行 device-stop，服务启动和握手验证由核心接着完成。 */
export function remoteSetup(lang: () => RemoteLang): RemoteSetupPlatform {
  return {
    prepare(target, version) {
      let touched = false
      const token = randomBytes(16).toString('hex')
      const run = async (
        stage: 'inspect' | 'download' | 'install' | 'clean',
        signal: AbortSignalLike = new AbortController().signal,
      ) => {
        const result = await runRemote(target, setupScript(stage, token, version, lang()), {
          signal,
          timeoutMs: stage === 'clean' ? 15_000 : stage === 'inspect' ? 45_000 : 600_000,
        })
        if (!result.marked || result.code !== 0)
          throw new Error(tailOf(result.stderr) ?? `SSH: ${result.code}`)
        return fields(result.out)
      }
      return {
        inspect: async (signal) => installBlocked(await run('inspect', signal)),
        async download(signal) {
          touched = true
          const out = await run('download', signal)
          if (out.step !== 'download' || out.code !== '0')
            throw new Error(out.said || `download: ${out.code ?? '?'}`)
        },
        async install(signal) {
          const result = readInstall(await run('install', signal), 'script')
          if (!result.ok)
            throw new Error(`${result.at} (${result.code ?? '?'}): ${result.said ?? ''}`)
          if (result.installed !== version)
            throw new Error(`verify: ${result.installed} ≠ ${version}`)
        },
        start: (signal) => startPeer(target, 'service', signal),
        async clean() {
          if (touched) await run('clean')
        },
      }
    },
  }
}
