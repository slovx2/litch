import {
  ChromeExecutor as Executor,
  type ChromeExecutorOptions as Options,
} from '../../../../third_party/litch-automation/packages/chrome-bridge/src/executor.mjs'

export { chromeFailure } from '../../../../third_party/litch-automation/packages/chrome-bridge/src/executor.mjs'
export type ChromeExecutorOptions = Omit<Options, 'namespace' | 'productName'>
export class ChromeExecutor extends Executor {
  constructor(options: ChromeExecutorOptions) {
    super({ ...options, namespace: 'litch_browser', productName: 'Litch' })
  }
}
