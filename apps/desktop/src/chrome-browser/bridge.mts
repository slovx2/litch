// Litch 实例的默认配置；库不默认信任任何产品身份。
import {
  ChromeBridge as Bridge,
  incompatibleMessage as message,
  type BridgeOptions as Options,
} from '../../../../packages/chrome-bridge/src/bridge.mjs'
import {
  CHROME_WIRE_MIN,
  CHROME_WIRE_VERSION,
  type ChromeInstance,
} from '../../../../packages/protocol/src/chrome-browser.mjs'

export { ChromeBridgeError } from '../../../../packages/chrome-bridge/src/bridge.mjs'
export type BridgeOptions = Omit<Options, 'protocol' | 'productName'>
export class ChromeBridge extends Bridge {
  constructor(options: BridgeOptions) {
    super({
      ...options,
      productName: 'Litch',
      protocol: { min: CHROME_WIRE_MIN, max: CHROME_WIRE_VERSION },
    })
  }
}
export const incompatibleMessage = (instance: ChromeInstance): string => message(instance, 'Litch')
