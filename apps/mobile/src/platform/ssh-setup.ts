import {
  installBlocked,
  type RemoteSetupPlatform,
  type RemoteTarget,
  readInstall,
} from '@litch/core'
import { ssh } from '../../modules/litch-ssh/src'
import { checkAborted, startPeer } from './ssh-probe'
import { parsePairs, setupScript } from './ssh-script'
import { namesOf, type RemoteConfig } from './ssh-transport'

/** 手机直接使用用户已信任的 SSH 主机和手机密钥，不借助桌面端。 */
export function mobileSetup(
  configFor: (target: RemoteTarget) => Promise<RemoteConfig>,
): RemoteSetupPlatform {
  return {
    prepare(target, version) {
      let token = ''
      let touched = false
      const run = async (
        stage: 'inspect' | 'download' | 'install' | 'clean',
        signal?: import('@litch/core').AbortSignalLike,
      ) => {
        if (signal) checkAborted(signal)
        const config = await configFor(target)
        const names = namesOf(config)
        token ||= names.randomHex()
        const script = setupScript(names, stage, token, version)
        const result = await ssh.runScript(
          {
            ...config.target,
            scriptTimeoutMs: stage === 'clean' || stage === 'inspect' ? 90_000 : 600_000,
          },
          script.text,
          script.marker,
        )
        if (signal) checkAborted(signal)
        if (!result.marked || result.code !== 0)
          throw new Error(result.stderr || `SSH: ${result.code}`)
        return parsePairs(result.output)
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
        async start(signal) {
          const config = await configFor(target)
          await startPeer(config, namesOf(config), 'service', signal)
        },
        async clean() {
          if (touched) await run('clean')
        },
      }
    },
  }
}
