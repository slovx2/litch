// 只等待本次原生读回的结果；不重新点击复制，不重读到绿。
const response = http.get(`${HELPER}/clipboard/result?id=${output.clipboardRequest}`)
const result = JSON.parse(response.body)
output.clipboardOk = response.status === 200 && typeof result.text === 'string' && !result.error
output.clipboard = result.text
