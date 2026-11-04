// 函数送到隐藏窗口执行；跨渲染进程重载检查真实预加载桥和应用数据文件。
export async function draftImageReloadProbe(stage: 'save' | 'restore'): Promise<void> {
  const until = async (read: () => boolean) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (read()) return
      await new Promise((done) => setTimeout(done, 25))
    }
    throw new Error(`图片草稿重开验收失败：${stage}`)
  }
  if (stage === 'save') {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 8
    canvas.getContext('2d')?.fillRect(0, 0, 8, 8)
    const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
    if (!png) throw new Error('无法创建验收图片')
    const clipboard = new DataTransfer()
    clipboard.items.add(new File([png], 'draft-reopen.png', { type: 'image/png' }))
    const input = document.querySelector<HTMLTextAreaElement>('.cmp textarea')
    if (!input) throw new Error('找不到图片草稿输入区')
    input
      .closest('.cmp')
      ?.dispatchEvent(
        new DragEvent('drop', { dataTransfer: clipboard, bubbles: true, cancelable: true }),
      )
    await until(() => !!document.querySelector('.cmp-att img[alt="draft-reopen.png"]'))
    await new Promise((done) => setTimeout(done, 50))
    return
  }
  await until(() => !!document.querySelector('.cmp-att img[alt="draft-reopen.png"]'))
  const image = document.querySelector('.cmp-att img[alt="draft-reopen.png"]')
  image?.closest('.cmp-att')?.querySelector<HTMLButtonElement>('.cmp-att-x')?.click()
  await until(() => !document.querySelector('.cmp-att img[alt="draft-reopen.png"]'))
  const storage = (window as unknown as { litchShell: { draftImages: { read(): unknown } } })
    .litchShell.draftImages
  await until(() => !JSON.stringify(storage.read()).includes('draft-reopen.png'))
}
