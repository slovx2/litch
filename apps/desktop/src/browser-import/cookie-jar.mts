// Litch 的接线入口；实现只在通用浏览器包维护。
import { electronCookieJar as createJar } from '../../../../third_party/litch-automation/packages/browser/src/browser-import/cookie-jar.mjs'
export function electronCookieJar(partition = 'persist:litch-browser') {
  return createJar(partition)
}
