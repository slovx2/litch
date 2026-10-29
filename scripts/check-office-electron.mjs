// 完整 Office 验收，使用正式 app:// 处理器；不再只跑原生冒烟子集。
process.argv.push('--electron')
await import('./check-office-preview.mjs')
