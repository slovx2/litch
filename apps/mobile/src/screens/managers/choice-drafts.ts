// 手机作答决策时选中的选项也是草稿（与桌面一样）：离开页面、重启后回来还在，提交或取消修改时清掉。
// 按“设备、经理、议题”存在应用文档目录，和补充文字的草稿（manager-replies.json）同一个键。
import { jsonFile } from '../../shell/json-file'

const file = jsonFile<Record<string, string>>('manager-choices.json')

/** 存着的选项；经理改掉了那个选项就当没选 */
export function readChoice(key: string, options: readonly { id: string }[]): string | null {
  const id = file.read()?.[key]
  return id && options.some((option) => option.id === id) ? id : null
}

/** 记下选中的选项；null 是清掉 */
export function writeChoice(key: string, optionId: string | null): void {
  const { [key]: _, ...rest } = file.read() ?? {}
  file.write(optionId ? { ...rest, [key]: optionId } : rest)
}
