// 构建自己的固定 ID Chrome 扩展；私钥不生成、不打包。

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

export async function buildChromeExtension(
  output = fileURLToPath(new URL('../dist/chrome-extension', import.meta.url)),
) {
  const identity = JSON.parse(
    await readFile(new URL('../../chrome-extension/identity.json', import.meta.url), 'utf8'),
  )
  const id = [
    ...createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest().subarray(0, 16),
  ]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join('')
  if (id !== identity.id) throw new Error('Chrome extension key and id do not match')
  const { version } = JSON.parse(
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  )
  await mkdir(output, { recursive: true })
  await build({
    entryPoints: [
      fileURLToPath(new URL('../../chrome-extension/src/background.mts', import.meta.url)),
    ],
    outfile: `${output}/background.js`,
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'chrome125',
    logLevel: 'warning',
  })
  await writeFile(
    `${output}/manifest.json`,
    JSON.stringify(
      {
        manifest_version: 3,
        name: 'Litch Browser',
        description: 'Connect Chrome to Litch. Click the extension to stop browser control.',
        version,
        minimum_chrome_version: '125',
        key: identity.key,
        background: { service_worker: 'background.js', type: 'module' },
        permissions: ['debugger', 'nativeMessaging', 'tabs', 'storage', 'webNavigation'],
        action: { default_title: 'Litch — Stop browser control' },
      },
      null,
      2,
    ) + '\n',
  )
  await writeFile(`${output}/identity.json`, JSON.stringify({ id, version }) + '\n')
  return { directory: output, id, version }
}
