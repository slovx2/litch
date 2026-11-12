// RN Web 挂正式 FilesScreen；页面间导航记录用于核对换根不会增加栈深。

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FilesScreen } from '../../apps/mobile/src/screens/files/FilesScreen'
import { makeTheme, ThemeContext } from '../../apps/mobile/src/ui/theme'

const api = (window as any).__filesNav
const initial = {
  deviceId: 'fixture',
  root: api.config.project,
  sessionId: 'one',
  workspaceId: 'project',
}
function Mobile() {
  const [stack, setStack] = useState([initial])
  api.stack = stack
  const navigation = {
    replace(_name: string, params: any) {
      setStack((before) => [...before.slice(0, -1), params])
    },
    push(_name: string, params: any) {
      setStack((before) => [...before, params])
    },
    goBack() {
      setStack((before) => (before.length > 1 ? before.slice(0, -1) : before))
    },
  }
  api.navigation = navigation
  api.session = (sessionId: string) => setStack([{ ...initial, sessionId }])
  return (
    <ThemeContext.Provider value={makeTheme('standard', false)}>
      <div style={{ width: 390, height: 844, display: 'flex', margin: 'auto' }}>
        <FilesScreen navigation={navigation as any} route={{ params: stack.at(-1) } as any} />
      </div>
    </ThemeContext.Provider>
  )
}
const element = document.createElement('div')
document.body.replaceChildren(element)
createRoot(element).render(<Mobile />)
