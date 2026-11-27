// 预检只读源文件与目标元数据；批准后校验完整传输，在目标目录内提交。
import { MACHINE_LIMITS } from '../../../../protocol/src/client-tools-machine.mjs'
import { decodeUtf8 } from '../../text/bytes.mjs'
import { ArgumentError, type LookedPath, type ToolKit } from './common.mjs'
import { lastPart, parentOf } from './paths.mjs'
import { runScript, scriptsFor } from './scripts.mjs'
import type { MachineFacts, MachineTarget } from './types.mjs'

interface Endpoint {
  label: string
  target: MachineTarget
  facts: MachineFacts
  looked: LookedPath
}

const sh = (script: string, ...args: string[]) => ['/bin/sh', '-c', script, 'litch', ...args]
const stat = `file_id() {
  if [ -x /usr/bin/sha256sum ]; then
    /usr/bin/stat -c '%d:%i:%f:%s:%y:%z' -- "$1"
  else
    /usr/bin/stat -f '%d:%i:%p:%z:%.9Fm:%.9Fc' -- "$1"
  fi
}
dir_id() {
  if [ -x /usr/bin/sha256sum ]; then
    /usr/bin/stat -c '%d:%i:%f' -- "$1"
  else
    /usr/bin/stat -f '%d:%i:%p' -- "$1"
  fi
}
file_hash() {
  if [ -x /usr/bin/sha256sum ]; then /usr/bin/sha256sum; else /usr/bin/shasum -a 256; fi
}`

const sourceProbe = `set -eu
${stat}
[ -f "$1" ] && [ ! -L "$1" ] || exit 1
before=$(file_id "$1")
hash=$(/usr/bin/head -c "$2" "$1" | file_hash)
printf '%s\n%s\n' "$before" "\${hash%% *}"
i=0
while [ "$i" -lt "$4" ]; do
  hash=$(/bin/dd if="$1" bs="$3" skip="$i" count=1 2>/dev/null | file_hash)
  printf '%s\n' "\${hash%% *}"
  i=$((i+1))
done
[ -f "$1" ] && [ ! -L "$1" ] && [ "$(file_id "$1")" = "$before" ] || exit 1`

const destination = `destination_id() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then printf absent
  elif [ -f "$1" ] && [ ! -L "$1" ]; then file_id "$1"
  else return 1
  fi
}`

const destProbe = `set -eu
${stat}
${destination}
cd -P -- "$1"
[ "$(pwd -P)" = "$1" ]
[ ! -L "$3" ]
parent=$(dir_id .)
dest=$(destination_id "./$2")
printf '%s\n%s\n' "$parent" "$dest"`

const write = `set -eu
${stat}
${destination}
cd -P -- "$1"
name=./$2
check_dest() {
  [ "$(pwd -P)" = "$1" ] && [ "$(dir_id .)" = "$3" ] &&
  [ "$(dir_id "$1")" = "$3" ] && [ "$(destination_id "$name")" = "$4" ]
}
check_dest "$@"
temp=$(/usr/bin/mktemp ./.litch-copy.XXXXXXXXXX)
trap '/bin/rm -f -- "$temp"' EXIT
trap 'exit 1' HUP INT TERM
/bin/cat > "$temp"
[ "$(/usr/bin/wc -c < "$temp" | /usr/bin/tr -d '[:space:]')" = "$5" ]
hash=$(file_hash < "$temp")
[ "\${hash%% *}" = "$6" ]
check_dest "$@"
if [ -x /usr/bin/sha256sum ]; then
  if [ "$4" = absent ]; then /bin/ln -T -- "$temp" "$name"; else /bin/mv -fT -- "$temp" "$name"; fi
else
  # BSD ln/mv 会把突然出现的目录当成容器。直接用系统调用发布确切文件名。
  /usr/bin/perl -e 'exit(($ARGV[0] eq "absent" ? link($ARGV[1], $ARGV[2]) : rename($ARGV[1], $ARGV[2])) ? 0 : 1)' "$4" "$temp" "$name"
fi`

interface FrozenCopy {
  source: string
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
      sh(sourceProbe, source, String(size + 1), String(chunkBytes), String(chunks)),
      {
        collect: 4096,
        timeoutMs: 30_000,
      },
    ),
    runScript(kit.runner, to.target, sh(destProbe, directory, name, to.looked.path), {
      collect: 1024,
    }),
  ])
  const [sourceIdentity, hash, ...chunkHashes] = decodeUtf8(src.stdout).trim().split('\n')
  const [parentIdentity, destinationIdentity] = decodeUtf8(dst.stdout).trim().split('\n')
  if (
    src.overflow ||
    dst.overflow ||
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
      write,
      copy.directory,
      copy.name,
      copy.parentIdentity,
      copy.destinationIdentity,
      String(copy.size),
      copy.hash,
    ),
    { cwd: to.facts.home, stdin: true, timeoutMs: 100_000 },
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
        scriptsFor(copy.source).readRange(copy.source, offset, length),
        { collect: length, timeoutMs: 20_000 },
      )
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
