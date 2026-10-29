// 固定测试页的只读结果与重置通道，不向任意网页提供宿主访问。
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('fixture', {
  report: (state) => ipcRenderer.send('fixture-state', state),
  onCommand: (fn) => ipcRenderer.on('fixture-command', (_event, action) => fn(action)),
})
