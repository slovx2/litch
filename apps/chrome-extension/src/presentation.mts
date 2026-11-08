import { TabPresentation as Presentation } from '../../../third_party/litch-automation/packages/chrome-extension/src/presentation.mjs'
export class TabPresentation extends Presentation {
  constructor(chrome: any) {
    super(chrome, 'Litch', 'litchTabPresentation:')
  }
}
