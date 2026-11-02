// 不重发命令：上一条 /file 已等待产物，失败时执行器也会保存相同证据。
const evidence = JSON.parse(http.get(`${HELPER}/terminal-evidence`).body)
output.commandComplete =
  (evidence.commands || '').split('\n').indexOf('echo e2e-$((6*7)) > e2e-mark.txt') >= 0
output.fileExact = evidence.file === 'e2e-42\n'
