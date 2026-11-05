// iOS 的无操作行不能吞掉子控件；有操作的行和 Android 继续保留整行语义。
export function rowAccessibility(
  platform: string,
  press: boolean,
  longPress: boolean,
  labelledSwitch: boolean,
): { accessible: false | undefined; hideTitle: boolean } {
  const separate = platform === 'ios' && !press && !longPress
  return { accessible: separate ? false : undefined, hideTitle: separate && labelledSwitch }
}
