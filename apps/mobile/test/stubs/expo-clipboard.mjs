let text = ''
export async function setStringAsync(value) {
  text = value
  return true
}
export async function getStringAsync() {
  return text
}
