let result = { canceled: true, assets: null }
export let options
export const setResult = (next) => {
  result = next
  options = undefined
}
export const launchImageLibraryAsync = async (value) => {
  options = value
  if (result instanceof Error) throw result
  return result
}
