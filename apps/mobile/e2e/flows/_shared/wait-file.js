// 问入口脚本（scripts/e2e.mjs 的小口）：夹具的工作目录里 NAME 这个文件有没有写出 TEXT。那边最多等十秒
const response = http.get(
  `${HELPER}/file?name=${encodeURIComponent(NAME)}&text=${encodeURIComponent(TEXT)}`,
)
output.found = response.status === 200
