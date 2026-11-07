import {
  createContext,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { Platform } from 'react-native'
import { ConsentDialog } from './ConsentDialog'
import type { ConsentRequest } from './consent'
import { createConsentHosts } from './consent-hosts'

const Context = createContext<{
  request: ConsentRequest | null
  hosts: ReturnType<typeof createConsentHosts>
} | null>(null)

export function ConsentPresentation({
  request,
  children,
}: {
  request: ConsentRequest | null
  children: ReactNode
}) {
  const [hosts] = useState(createConsentHosts)
  const host = useSyncExternalStore(hosts.subscribe, hosts.current, hosts.current)
  const value = useMemo(() => ({ request, hosts }), [request, hosts])
  return (
    <Context.Provider value={value}>
      {children}
      {Platform.OS === 'ios' ? <ConsentDialog request={host === null ? request : null} /> : null}
    </Context.Provider>
  )
}

/** 放在原生 Modal 内部，让编辑弹窗与讨论抽屉里的同意框从当前窗口展示。 */
export function ModalConsentHost({ active }: { active: boolean }) {
  const context = useContext(Context)
  if (!context) throw new Error('同意框承载点必须位于 ConsentPresentation 内')
  const { request, hosts } = context
  const id = useId()
  const host = useSyncExternalStore(hosts.subscribe, hosts.current, hosts.current)
  useLayoutEffect(() => (active ? hosts.register(id) : undefined), [active, hosts, id])
  return Platform.OS === 'ios' ? (
    <ConsentDialog request={active && host === id ? request : null} />
  ) : null
}
