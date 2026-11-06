import {
  CHROME_HOST_NAME,
  CHROME_WIRE_MIN,
  CHROME_WIRE_VERSION,
  chromeExtensionIds,
} from '../../../packages/automation-contracts/src/litch/chrome-browser.mjs'
import { createExtensionRuntime } from '../../../packages/chrome-extension/src/index.mjs'

declare const chrome: any
declare const __LITCH_POINTER_SOURCE__: string

const runtime = createExtensionRuntime({
  chrome,
  identity: {
    hostName: CHROME_HOST_NAME,
    extensionIds: chromeExtensionIds(),
    productName: 'Litch',
  },
  protocol: { min: CHROME_WIRE_MIN, max: CHROME_WIRE_VERSION },
  storagePrefix: 'litch',
  pointerSource: __LITCH_POINTER_SOURCE__,
})
void runtime.start()
