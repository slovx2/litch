// 仅供浏览器预览：模拟钥匙只存当前页面内存，刷新即清除，不读写系统钥匙串。
const values = new Map<string, string>()
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 7
export const getItemAsync = async (key: string): Promise<string | null> => values.get(key) ?? null
export const setItemAsync = async (key: string, value: string): Promise<void> => {
  values.set(key, value)
}
export const deleteItemAsync = async (key: string): Promise<void> => {
  values.delete(key)
}
