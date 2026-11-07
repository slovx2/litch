import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { Platform } from 'react-native'
import { ConsentDialog } from './ConsentDialog'
import type { ConsentView } from './consent-access'
import { createConsentHosts } from './consent-hosts'
import { aiConsent } from './storage'

const Context = createContext<{
  view: ConsentView
  hosts: ReturnType<typeof createConsentHosts>
} | null>(null)

export function ConsentPresentation({ children }: { children: ReactNode }) {
  const view = useSyncExternalStore(aiConsent.subscribe, aiConsent.current, aiConsent.current)
  useEffect(() => aiConsent.launch(Platform.OS), [])
  const [hosts] = useState(createConsentHosts)
  const host = useSyncExternalStore(hosts.subscribe, hosts.current, hosts.current)
  const value = useMemo(() => ({ view, hosts }), [view, hosts])
  return (
    <Context.Provider value={value}>
      {children}
      {Platform.OS === 'ios' ? <ConsentDialog view={host === null ? view : null} /> : null}
    </Context.Provider>
  )
}

/** 放在原生 Modal 内部，让编辑弹窗与讨论抽屉里的同意框从当前窗口展示。 */
export function ModalConsentHost({ active }: { active: boolean }) {
  const context = useContext(Context)
  if (!context) throw new Error('同意框承载点必须位于 ConsentPresentation 内')
  const { view, hosts } = context
  const id = useId()
  const host = useSyncExternalStore(hosts.subscribe, hosts.current, hosts.current)
  useLayoutEffect(() => (active ? hosts.register(id) : undefined), [active, hosts, id])
  return Platform.OS === 'ios' ? <ConsentDialog view={active && host === id ? view : null} /> : null
}
