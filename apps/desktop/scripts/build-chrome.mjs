// 构建自己的固定 ID Chrome 扩展；私钥不生成、不打包。

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const ICON_SIZES = [16, 32, 48, 128]

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
  const pointer = await build({
    entryPoints: [
      fileURLToPath(new URL('../../chrome-extension/src/pointer-world.mts', import.meta.url)),
    ],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome125',
    write: false,
    logLevel: 'warning',
  })
  await build({
    define: { __LITCH_POINTER_SOURCE__: JSON.stringify(pointer.outputFiles[0].text) },
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
  // 图标由 make-brand.py 生成后提交；产物目录保持平铺（安装时逐个文件拷，见 installer.mts）
  const icons = Object.fromEntries(ICON_SIZES.map((side) => [String(side), `icon-${side}.png`]))
  for (const file of Object.values(icons))
    await copyFile(
      new URL(`../../chrome-extension/icons/${file}`, import.meta.url),
      `${output}/${file}`,
    )
  await writeFile(
    `${output}/manifest.json`,
    `${JSON.stringify(
      {
        manifest_version: 3,
        name: 'Litch Browser',
        description: 'Connect Chrome to Litch. Click the extension to stop browser control.',
        version,
        minimum_chrome_version: '125',
        key: identity.key,
        icons,
        background: { service_worker: 'background.js', type: 'module' },
        permissions: ['debugger', 'nativeMessaging', 'tabs', 'storage', 'webNavigation'],
        action: { default_title: 'Litch — Stop browser control', default_icon: icons },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(`${output}/identity.json`, `${JSON.stringify({ id, version })}\n`)
  return { directory: output, id, version }
}
