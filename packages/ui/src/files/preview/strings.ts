import { useMemo } from 'react'
import { useAppearance } from '../../app/appearance.ts'
import { type Args, type Entry, formatEntry } from '../../i18n/types.ts'

/** 各 renderer 的两份文案留在自己的目录，仍通过 t('键')，无需争改全局目录。 */
export function useRendererText<Z extends Record<string, Entry>>(
  zh: Z,
  en: Record<keyof Z, Entry>,
) {
  const { lang } = useAppearance()
  return useMemo(
    () => (key: keyof Z, args?: Args) => formatEntry((lang === 'zh-CN' ? zh : en)[key], args),
    [lang, zh, en],
  )
}
