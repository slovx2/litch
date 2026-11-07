/** 隐藏窗口内验证 Claude 式工具小图与查看器，不保存截图或验收文件。 */
export async function toolImagesProbe(): Promise<string[]> {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const wait = async <T,>(read: () => T, label: string): Promise<NonNullable<T>> => {
    const end = performance.now() + 15000
    while (performance.now() < end) {
      const found = read()
      if (found) return found as NonNullable<T>
      await sleep(25)
    }
    throw new Error(
      `工具图片验收超时：${label}；查看器=${document.querySelector('.tool-image-dialog')?.textContent?.slice(0, 300) ?? '不存在'}`,
    )
  }
  const query = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s)
  const all = (s: string) => [...document.querySelectorAll<HTMLElement>(s)]
  const session = await wait(
    () =>
      all('.ss-row:not(.projection-group *)').find((row) =>
        row.textContent?.includes('远程设备安装指引'),
      ),
    '模拟会话',
  )
  session.click()
  await wait(() => query('.crumb')?.textContent?.includes('远程设备安装指引'), '模拟会话打开')
  const input = await wait(() => query<HTMLTextAreaElement>('.dock textarea.cmp-text'), '输入框')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    input,
    'tool images',
  )
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await sleep(30)
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  await wait(
    () =>
      !query('.running-line') &&
      all('.md').some((node) => node.textContent?.includes('工具读图完成')),
    '最终回答',
  )
  if (!query('.steps .tool-images')) all('.proc-head[aria-expanded="false"]').at(-1)?.click()
  const strip = await wait(() => query('.steps .tool-images'), '图片条')
  const failures: string[] = []
  const checks = (ok: boolean, label: string) => {
    if (!ok) failures.push(label)
  }
  const chips = [...strip.querySelectorAll<HTMLElement>('.tool-image-open')].filter(
    (node) => node.getBoundingClientRect().width > 0,
  )
  checks(chips.length === 3, `应露最近3张，实际${chips.length}`)
  checks(
    chips.every(
      (node) =>
        Math.abs(node.getBoundingClientRect().height - 24) < 1 &&
        node.getBoundingClientRect().width <= 44,
    ),
    '缩略图尺寸应24px高、最大44px宽',
  )
  const more = strip.querySelector<HTMLButtonElement>('.tool-images-more.tool-images-wide')
  checks(more?.textContent === '+1', '应有+1入口')
  more?.click()
  await wait(() => query<HTMLImageElement>('.tool-image-stage img')?.naturalWidth, '原图按需加载')
  const dialog = query<HTMLDialogElement>('.tool-image-dialog')!
  const nav = () => query('.tool-image-nav')!
  checks(nav().textContent?.includes('1 / 4') === true, '应从第一张进入全组图库')
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  await wait(() => nav().textContent?.includes('4 / 4'), 'End跳末图')
  checks((nav().querySelectorAll('button')[1] as HTMLButtonElement).disabled, '末图下一张应禁用')
  dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await wait(() => nav().textContent?.includes('3 / 4'), '左方向切图')
  await wait(() => query<HTMLImageElement>('.tool-image-stage img')?.naturalWidth, '切图加载')
  query('.tool-image-stage')!.click()
  await wait(
    () => query<HTMLImageElement>('.tool-image-stage img')?.style.transform.includes('scale(2)'),
    '点击放大',
  )
  // 点遮罩空白处直接关闭，放大时也不再先还原
  query('.tool-image-backdrop')!.click()
  await wait(() => !query('.tool-image-dialog'), '背景关闭')
  const group = strip.closest('.steps')!
  group.querySelector<HTMLElement>('.steps-head')!.click()
  await wait(() => group.querySelector('.steps-body .tool-images'), '展开组后工具行小图')
  checks(
    group.querySelector(':scope > .tool-image-summary .tool-images') === null,
    '展开后组条应隐藏',
  )
  return failures
}
