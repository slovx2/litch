import { TabPresentation as Presentation } from '../../../packages/chrome-extension/src/presentation.mjs'
export class TabPresentation extends Presentation {
  constructor(chrome: any) {
    super(chrome, 'Litch', 'litchTabPresentation:')
  }
}
