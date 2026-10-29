// 父会话待处理区里子会话请求那一行的文字，两端共用：登录审批写成“登录 某网站”，
// 标题为空时用兜底文案。传入各端自己的 t。
type Translate = (
  key: 'ask.signIn' | 'ask.signInFallback' | 'ask.requestFallback',
  args?: { site: string },
) => string

export function requestLabel(
  request: { kind: string; title?: string } | undefined,
  t: Translate,
): string {
  const title = request?.title?.trim() ?? ''
  if (request?.kind === 'clientApproval')
    return title ? t('ask.signIn', { site: title }) : t('ask.signInFallback')
  return title || t('ask.requestFallback')
}
