import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/400-italic.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
// 复古皮肤的字
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/400-italic.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
// 文艺皮肤的字。中文衬线字用系统自带的
import '@fontsource/literata/400.css'
import '@fontsource/literata/400-italic.css'
import '@fontsource/literata/500.css'
import '@fontsource/literata/600.css'
import '@fontsource/sometype-mono/400.css'
import '@fontsource/sometype-mono/500.css'
import '@fontsource/sometype-mono/600.css'
import './styles/index.css'
import { createReplica, createSidebarActivity } from '@litch/core'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { currentLang } from './app/appearance.ts'
import { watchForeground } from './app/foreground.ts'
import { currentPlatform } from './app/platform.ts'
import { ServicesProvider } from './app/services.tsx'
import { browserClock, openChannel } from './boot/channel.ts'

const { channel: transport, shell } = await openChannel(currentLang())
const activity = createSidebarActivity(transport, browserClock, {
  load: () => JSON.parse(localStorage.getItem('litch.sidebar.activity') ?? '[]'),
  save: (entries) => localStorage.setItem('litch.sidebar.activity', JSON.stringify(entries)),
})
const channel = activity.channel
const replica = createReplica(channel, activity)
watchForeground(
  {
    visible: () => document.visibilityState === 'visible',
    focused: () => document.hasFocus(),
    listen(event, changed) {
      const target = event === 'visibilitychange' ? document : window
      target.addEventListener(event, changed)
      return () => target.removeEventListener(event, changed)
    },
    ...(window.litchShell ? { native: window.litchShell.onForeground } : {}),
  },
  activity.setForeground,
)
window.addEventListener('pagehide', () => activity.flush())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') activity.flush()
})
replica.start()
// 样式要按外壳和系统区分一处：macOS 的桌面外壳里系统的窗口按钮盖在标题栏左上角，要给它让位置；
// 别的系统上窗口按钮在系统自己的标题栏里，不用让
document.documentElement.dataset.shell = shell
document.documentElement.dataset.platform = currentPlatform()

const root = document.getElementById('root')
if (!root) throw new Error('页面里没有挂载点')
createRoot(root).render(
  <StrictMode>
    <ServicesProvider value={{ channel, replica, shell }}>
      <App />
    </ServicesProvider>
  </StrictMode>,
)
