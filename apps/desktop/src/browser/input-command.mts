// 输入命令的边界，两种浏览器及扩展共用；只对这些命令给派发回执，不放宽读操作的文档检查。
export const INPUT_PREPARE_MARK = '/* litch-input-prepare */'
export const isInputCommand = (method: string, params: Record<string, unknown> = {}): boolean =>
  method.startsWith('Input.') ||
  method === 'DOM.setFileInputFiles' ||
  method === 'DOM.scrollIntoViewIfNeeded' ||
  method === 'Page.handleJavaScriptDialog' ||
  (method === 'Runtime.callFunctionOn' &&
    String(params.functionDeclaration).includes(INPUT_PREPARE_MARK))
