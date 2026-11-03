let result = { canceled: true, assets: null }
export const setResult = (next) => {
  result = next
}
export const getDocumentAsync = async () => result
