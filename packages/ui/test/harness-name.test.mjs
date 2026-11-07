import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'
import { nameOf } from '../src/app/device.ts'
import { translator } from '../src/i18n/index.ts'

test('ACP 在两种界面语言下显示独立名字，保留原始标识与设备数据', () => {
  const device = { harnesses: [{ id: 'acp', name: 'ACP', badge: 'AC' }] }
  for (const [lang, expected] of [
    ['zh-CN', '其他 ACP Agent'],
    ['en', 'Other ACP agent'],
  ]) {
    const t = translator(lang)
    assert.equal(t.harness('acp', 'ACP'), expected)
    assert.equal(nameOf(device, 'acp', t), expected)
    assert.equal(t.harness('gemini', 'Gemini CLI'), 'Gemini CLI')
    assert.equal(t.harness('custom', 'Custom ACP endpoint'), 'Custom ACP endpoint')
    assert.equal(t.harness('unknown'), 'unknown')
    assert.match(t('onboard.intro.acp'), /Gemini/)
    assert.match(t('onboard.intro.acp'), /Qwen/)
  }
  assert.equal(device.harnesses[0].name, 'ACP')
  assert.equal(device.harnesses[0].id, 'acp')
})

test('手机使用相同的双语 ACP 名称和说明', async () => {
  const output = await build({
    entryPoints: [new URL('../../../apps/mobile/src/ui/i18n.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'platform',
        setup(api) {
          api.onResolve({ filter: /^(react|expo-localization)$/ }, (args) => ({
            path: args.path,
            namespace: 'stub',
          }))
          api.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
            contents:
              args.path === 'react'
                ? 'export const createContext=v=>v; export const useContext=v=>v;'
                : 'export const getLocales=()=>[{languageTag:"zh-CN"}];',
          }))
        },
      },
    ],
  })
  const mobile = await import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`
  )
  for (const lang of ['zh-CN', 'en']) {
    assert.equal(mobile.translator(lang).harness('acp', 'ACP'), translator(lang).harness('acp'))
    assert.equal(
      mobile.translator(lang)('onboard.intro.acp'),
      translator(lang)('onboard.intro.acp'),
    )
  }
})
