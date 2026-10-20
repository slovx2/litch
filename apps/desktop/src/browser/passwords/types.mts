// 密码库对导入管线的接口。形状照设计（导入管线的 browser-import/protected-types.mts 的 ImportedPassword、
// browser-import/sinks.mts 的 ImportCounts 和 PasswordSink）；那两份在管线的分支上，这里先按同样的结构写一份，
// 合并时改成引用那边的。

/** 读取器读出来的一条已保存的密码（明文只在一次导入的函数栈里） */
export interface ImportedPassword {
  /** 登录页的源，`https://accounts.example.com` */
  origin: string
  /** 完整的登录页地址（来源有就给） */
  url?: string
  /** 表单提交去的源（来源有就给） */
  actionOrigin?: string
  username: string
  password: string
  usernameField?: string
  passwordField?: string
  /** Unix 秒 */
  created?: number
  lastUsed?: number
  /** Chromium 系分本地资料和登录账号两份，Firefox 一律 profile */
  store: 'profile' | 'account'
}

export interface ImportCounts {
  imported: number
  skippedExisting: number
  skippedInvalid: number
  failed: number
}

/** source 是来源的标识，比如 `chrome:Default`，存进记录里方便以后看来源 */
export interface PasswordSink {
  importMany(items: ImportedPassword[], source: string): Promise<ImportCounts>
}
