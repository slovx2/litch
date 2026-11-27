// 预检只读源文件与目标元数据；批准后校验完整传输，在目标目录内提交。
import { MACHINE_LIMITS } from '../../../../protocol/src/client-tools-machine.mjs'
import { decodeUtf8 } from '../../text/bytes.mjs'
import { ArgumentError, type LookedPath, type ToolKit } from './common.mjs'
import {
  copyDestProbe,
  copyDestWrite,
  copySourceProbe,
  copySourceRead,
} from './copy-frozen-scripts.mjs'
import { lastPart, parentOf } from './paths.mjs'
import { runScript } from './scripts.mjs'
import type { MachineFacts, MachineTarget } from './types.mjs'

interface Endpoint {
  label: string
  target: MachineTarget
  facts: MachineFacts
  looked: LookedPath
}

const sh = (script: string, ...args: string[]) => ['/bin/sh', '-c', script, 'litch', ...args]
interface FrozenCopy {
  source: string
  sourceParentIdentity: string
  sourceIdentity: string
  directory: string
  name: string
  parentIdentity: string
  destinationIdentity: string
  size: number
  hash: string
  chunkHashes: string[]
  fingerprint: string
  details: string
}

const atTransferRateMs = (bytes: number) => Math.ceil((bytes / (128 * 1024)) * 1000)
export const copyTimeoutMs = (bytes: number) =>
  Math.min(100_000 + atTransferRateMs(bytes), MACHINE_LIMITS.deferredCopyMaxMs)

export async function freezeCopy(
  kit: ToolKit,
  from: Endpoint,
  to: Endpoint,
  chunkBytes: number,
): Promise<FrozenCopy> {
  const size = from.looked.probe.size
  if (
    (from.target.role !== 'desktop' && to.target.role !== 'desktop') ||
    ![from.facts.system, to.facts.system].every((system) => /^(macOS|Linux)\b/i.test(system))
  )
    throw new ArgumentError('Deferred copy needs a Mac and a macOS or Linux file endpoint.')
  if (from.looked.probe.type !== 'f' || size === null)
    throw new ArgumentError(
      'Deferred copy accepts one regular file. Package folders on the source machine first.',
    )
  if (!Number.isSafeInteger(size) || size < 0 || size > MACHINE_LIMITS.deferredCopyBytes)
    throw new ArgumentError('Deferred copy is limited to 100 MiB. Copy a smaller file.')
  const source = from.looked.probe.real
  const dest = to.looked.probe.real
  if (
    (to.looked.probe.type !== 'm' && to.looked.probe.type !== 'f') ||
    lastPart(dest) !== lastPart(to.looked.path) ||
    !lastPart(dest)
  )
    throw new ArgumentError('Deferred copy needs a regular destination file or an unused filename.')
  const directory = parentOf(dest)
  const name = lastPart(dest)
  const chunks = Math.ceil(size / chunkBytes)
  if (!kit.context.hashBytes)
    throw new ArgumentError('This desktop cannot verify a deferred transfer.')
  const [src, dst] = await Promise.all([
    runScript(
      kit.runner,
      from.target,
      sh(
        copySourceProbe,
        parentOf(source),
        lastPart(source),
        String(size + 1),
        String(chunkBytes),
        String(chunks),
      ),
      {
        collect: 4096,
        timeoutMs: 30_000,
      },
    ),
    runScript(kit.runner, to.target, sh(copyDestProbe, directory, name, to.looked.path), {
      collect: 1024,
    }),
  ])
  const [sourceParentIdentity, sourceIdentity, hash, ...chunkHashes] = decodeUtf8(src.stdout)
    .trim()
    .split('\n')
  const [parentIdentity, destinationIdentity] = decodeUtf8(dst.stdout).trim().split('\n')
  if (
    src.overflow ||
    dst.overflow ||
    !sourceParentIdentity ||
    !sourceIdentity ||
    !hash ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    chunkHashes.length !== chunks ||
    chunkHashes.some((value) => !/^[0-9a-f]{64}$/.test(value)) ||
    !parentIdentity ||
    !destinationIdentity ||
    (destinationIdentity === 'absent') !== (to.looked.probe.type === 'm')
  )
    throw new ArgumentError('Could not verify the source or destination for deferred copy.')
  const details = JSON.stringify(
    {
      file: lastPart(source),
      bytes: size,
      from: { machine: from.label, path: source },
      to: { machine: to.label, path: dest },
      overwrite: destinationIdentity !== 'absent',
      sha256: hash,
    },
    null,
    2,
  )
  const fingerprint = JSON.stringify([
    from.target.id,
    from.facts.hostname,
    from.looked.path,
    from.looked.rules,
    sourceParentIdentity,
    sourceIdentity,
    to.target.id,
    to.facts.hostname,
    to.looked.path,
    to.looked.rules,
    parentIdentity,
    destinationIdentity,
    chunkHashes,
    details,
  ])
  return {
    source,
    sourceParentIdentity,
    sourceIdentity,
    directory,
    name,
    parentIdentity,
    destinationIdentity,
    size,
    hash,
    chunkHashes,
    fingerprint,
    details,
  }
}

export async function runFrozenCopy(
  kit: ToolKit,
  from: Endpoint,
  to: Endpoint,
  copy: FrozenCopy,
  chunkBytes: number,
): Promise<number> {
  const signal = kit.context.signal
  const hashBytes = kit.context.hashBytes
  if (signal.aborted || !hashBytes) throw new ArgumentError('The approved copy was cancelled.')
  const writer = await kit.runner.run(
    to.target,
    sh(
      copyDestWrite,
      copy.directory,
      copy.name,
      copy.parentIdentity,
      copy.destinationIdentity,
      String(copy.size),
      copy.hash,
    ),
    {
      cwd: to.facts.home,
      stdin: true,
      timeoutMs: copyTimeoutMs(copy.size),
      writeTimeoutMs: 20_000 + atTransferRateMs(chunkBytes),
    },
  )
  let running = true
  const stop = () => {
    if (running) writer.kill()
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    for (let offset = 0; offset < copy.size; ) {
      if (signal.aborted) throw new ArgumentError('The approved copy was cancelled.')
      const length = Math.min(chunkBytes, copy.size - offset)
      const chunk = await runScript(
        kit.runner,
        from.target,
        sh(
          copySourceRead,
          parentOf(copy.source),
          lastPart(copy.source),
          copy.sourceParentIdentity,
          copy.sourceIdentity,
          String(offset),
          String(length),
        ),
        { collect: length, timeoutMs: 20_000 + atTransferRateMs(length) },
      ).catch(() => {
        throw new ArgumentError('The approved source changed or could not be read.')
      })
      if (
        chunk.overflow ||
        chunk.stdout.length !== length ||
        signal.aborted ||
        hashBytes(chunk.stdout) !== copy.chunkHashes[offset / chunkBytes]
      )
        throw new ArgumentError('The approved source changed or the copy was cancelled.')
      await writer.write(chunk.stdout)
      offset += length
    }
    if (signal.aborted) throw new ArgumentError('The approved copy was cancelled.')
    await writer.write(new Uint8Array(0), true)
    const exit = await writer.done
    if (exit.kind !== 'exited' || exit.exitCode !== 0)
      throw new ArgumentError('The transfer failed or the approved source or destination changed.')
    return copy.size
  } catch (error) {
    stop()
    throw error
  } finally {
    running = false
  }
}
