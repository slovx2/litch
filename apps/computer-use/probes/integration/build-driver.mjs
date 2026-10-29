// Node 驱动使用真实核心、SSH transport 和宿主，不需启动额外 Electron 外壳。

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../../../../node_modules/esbuild/lib/main.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
await build({
  stdin: {
    contents: [
      "export {createCore,reduceSession} from './packages/core/src/index.mts'",
      "export {sshOpener} from './apps/desktop/src/transport-ssh.mts'",
      "export {createClientToolHost} from './apps/desktop/src/client-tools/host.mts'",
      "export {createComputerExecutor} from './apps/desktop/src/computer-use/executor.mts'",
      "export {MacLauncher} from './apps/desktop/src/computer-use/launcher-mac.mts'",
      "export {createAutomationPreviewHost} from './apps/desktop/src/automation-preview/host.mts'",
    ].join('\n'),
    resolveDir: root,
  },
  outfile: join(root, 'apps/computer-use/.artifacts/integration/remote-driver.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  alias: { '@litch/core': join(root, 'packages/core/src/index.mts') },
  external: ['electron'],
  banner: {
    js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);",
  },
})
