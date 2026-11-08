// 构建嵌入使用方扩展的两个入口；不选择产品身份，不登记系统宿主。
import { createHash } from 'node:crypto'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { build } from 'esbuild'

export function extensionId(key) {
  return [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join('')
}

/** manifest/图标属于组装方；权限不会由库暗中增加。pointerDefine 对应其入口的编译常量。 */
export async function assembleExtension({
  output,
  background,
  pointer,
  pointerDefine,
  identity,
  manifest,
  icons = [],
}) {
  const id = extensionId(identity.key)
  if (id !== identity.id) throw new Error('Chrome extension key and id do not match')
  if (manifest.key !== identity.key)
    throw new Error('Chrome manifest key and identity do not match')
  await mkdir(output, { recursive: true })
  const content = await build({
    entryPoints: [pointer],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome125',
    write: false,
    logLevel: 'warning',
  })
  await build({
    entryPoints: [background],
    outfile: join(output, 'background.js'),
    define: { [pointerDefine]: JSON.stringify(content.outputFiles[0].text) },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome125',
    logLevel: 'warning',
  })
  for (const file of icons) await copyFile(file, join(output, basename(file)))
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(
    join(output, 'identity.json'),
    `${JSON.stringify({ id, version: manifest.version })}\n`,
  )
  return { directory: output, id, version: manifest.version }
}
