// 手机上批准（扩展名 clientApprovals）：桌面端要人点头的卡片经会话所在设备的设备服务转给绑了这台设备的手机，
// 手机的答复带着批准钥匙的签名经设备服务交回发卡片的那条连接。定义的原文在仓库根目录
// protocol/extensions/client-approvals.json。第一版只有一种卡片：内置浏览器的代理登录（browserSignIn）。
//
// 这个文件不引用别的文件：设备进程（packages/device）、客户端核心（packages/core）、桌面端和移动端都直接引用它。
// 移动端的核心跑在 Hermes 上，这里只能用纯 JS，不能用 node:crypto、Buffer、TextEncoder。
//
// 三方：
// - 桌面端（出卡片、验签的一方）：litch/approval/open 把卡片交给会话所在的设备，收到 litch/approval/answered 后
//   自己验签，验不过的丢掉、卡片接着等；人在桌面端答了、回合结束、过期时 litch/approval/close。
// - 设备服务：只转交，不验签（它不可信：代理就跑在那台设备上，和它是同一个用户）。卡片只放内存，
//   发卡片的那条连接断了就收掉，过了 expiresAt 也收掉。
// - 手机：litch/approval/list 取现在挂着的，之后跟着 litch/approval/changed；答复用 litch/approval/answer。
//
// 方法不看握手时的声明（手机、桌面端都会声明，命令行用不着）；但 open 要求发卡片的连接声明了 clientApprovals，
// 不然答复没处送。通知 litch/approval/changed 只发给声明了 clientApprovals 的连接，
// litch/approval/answered 只发给发卡片的那一条。设备信息（runtime/info 的 device.extensions）里列了 clientApprovals 才能用。

// 扩展名登记在 device.mts 的 EXTENSION.clientApprovals。

// ---------- 常量 ----------

/** 签名内容的固定前缀，后面接一行 JSON（approvalSignedText） */
export const APPROVAL_SIGN_PREFIX = 'litch-approval-v1\n'
/** 一条连接同时最多挂多少张卡片；再开回 tooMany */
export const APPROVAL_MAX_PER_CONNECTION = 32
/** 摘要里各段文字的上限（UTF-16 码元），设备服务截断 */
export const APPROVAL_TEXT_MAX = { site: 200, reason: 1000, device: 200, masked: 200, task: 200 }
/** 一张卡片最多列多少个账号 */
export const APPROVAL_ACCOUNTS_MAX = 50

/** 卡片号、随机数、桌面端号、账号的 ref：字母数字加 _-，卡片号、随机数、桌面端号至少 16 个字 */
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/
const REF = /^[A-Za-z0-9_-]{1,64}$/
/** 手机号：和 devicePairing 的一样，手机 ssh 公钥的 SHA-256 前 8 字节的小写十六进制 */
const PHONE_ID = /^[0-9a-f]{16}$/
/** 批准公钥：ed25519 的 32 字节，标准 base64（带填充，44 个字） */
const APPROVAL_KEY = /^[A-Za-z0-9+/]{43}=$/
/** 签名：ed25519 的 64 字节，标准 base64（带填充，88 个字） */
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/

// ---------- 批准钥匙与签名（算法，桌面端用 Node、手机各自实现） ----------
//
// 批准钥匙：手机另生成的一把 ed25519，专门签批准，和 ssh 用的钥匙无关；一台手机一把，存 SecureStore，取用要过生物识别。
// 公钥在协议里写成 32 字节原始公钥的标准 base64（approvalKey）。
// 签名：对 UTF-8( approvalSignedText(...) ) 做 ed25519 签名（不预先哈希），64 字节写成标准 base64。
// 指纹（两边设置里显示、桌面端第一次记下时提示里写的）：32 字节原始公钥做 SHA-256，取前 8 字节的小写十六进制，
//   每 4 个字一组、空格隔开，共 4 组。
//
// 测试向量：私钥种子是 0x01、0x02……0x20 这 32 个字节，
//   approvalKey "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ="，指纹 "65b6 0673 d6ed 884b"；
//   卡片 { id "Ap7cK2mQ9xW4rT6v", nonce "Nq3vL8sD1fG5hJ0k", desktopId "Dz5yX2wV8uT1sR4q", origin "https://github.com" }，
//   答复 { ref "a1", decision "approve", remember false, phoneId "f83898df0bef57a4" } 的签名内容是
//   'litch-approval-v1\n{"id":"Ap7cK2mQ9xW4rT6v","nonce":"Nq3vL8sD1fG5hJ0k","desktopId":"Dz5yX2wV8uT1sR4q",'
//   + '"origin":"https://github.com","ref":"a1","decision":"approve","remember":false,"phoneId":"f83898df0bef57a4"}'，
//   签名 "CN7xYgg3bNV+mLfeWMRmrBSPbHMehY5JKWZsnml5M/74XWpsoitp1YZPbsqV+k0saqYZWQ9V3WbJw7og4d0DAw=="
//
// 扫码绑定时带上批准公钥（device-pairing.mts 的 PairEnrollInput.approvalKey）：确认码改成
//   SHA-256( UTF-8( 配对号 + "\n" + 手机公钥行 + "\n" + approvalKey ) ) 取前 4 字节……（其余同原来的算法），
//   带上的批准公钥就被人核对过的确认码盖住了。上面配对的测试向量加上这把批准公钥，确认码是 "977558"。

/**
 * 要签的那一段：前缀加一行 JSON，键按这个顺序。id、nonce、desktopId、origin 取卡片上的
 * （桌面端验签时用自己记着的，不用答复里带回来的），其余取答复的
 */
export function approvalSignedText(
  card: { id: string; nonce: string; desktopId: string; origin: string },
  answer: Pick<ApprovalAnswer, 'ref' | 'decision' | 'remember' | 'phoneId'>,
): string {
  return (
    APPROVAL_SIGN_PREFIX +
    JSON.stringify({
      id: card.id,
      nonce: card.nonce,
      desktopId: card.desktopId,
      origin: card.origin,
      ref: answer.ref,
      decision: answer.decision,
      remember: answer.remember,
      phoneId: answer.phoneId,
    })
  )
}

// ---------- 卡片 ----------

/** 卡片的种类。以后加别的审批（网站审批之类）在这里加，第一版只有登录 */
export type ApprovalKind = 'browserSignIn'

/** 卡片上的一个账号：只给打码的用户名，用 ref 指（ref 是这张卡片里随机的不透明编号，不是密码库的条目号） */
export interface ApprovalAccount {
  ref: string
  /** 打码的用户名，比如 so•••@gmail.com */
  masked: string
}

/** 代理登录这张卡片给人看的摘要。会经过设备服务，代理看得到，所以不放用户名明文 */
export interface BrowserSignInSummary {
  /** 页面的真实源（主进程从框架取的），比如 https://accounts.google.com */
  origin: string
  /** 代理给的站名（代理说的） */
  site: string
  /** 代理给的原因（代理说的） */
  reason: string
  /** 会话所在设备在桌面端的名字 */
  device: string
  /** 密码库里和这个源完全一样的条目，最近用过的在前。没有可代填的账号是空的 */
  accounts: ApprovalAccount[]
  /** 定时任务的回合才有：卡片上出“这个定时任务以后直接用这个账号”的勾选 */
  task: { id: string; name: string } | null
  /** 预检不过、不能代填的原因（第六节第 1 步的那几种），能代填是 null */
  fillBlocked: string | null
}

/** 一张卡片。open 交的就是它；list、changed 里的多一个 openedAt */
export interface ApprovalCard {
  /** 桌面端出的卡片号，随机，至少 16 个字 */
  id: string
  /** 卡片挂在哪个会话上（发起调用的那个） */
  threadId: string
  kind: ApprovalKind
  summary: BrowserSignInSummary
  /** 出卡片的桌面端的标识（桌面端自己记着的随机号，验签时核对） */
  desktopId: string
  /** 桌面端给这张卡片出的随机数，签名里要带；用一次作废 */
  nonce: string
  /** 毫秒时间戳，过了设备服务收掉。不限时是 null（普通会话不限时，只有定时任务的回合有） */
  expiresAt: number | null
}

export interface ApprovalCardView extends ApprovalCard {
  /** 设备服务收下这张卡片的时间，毫秒时间戳 */
  openedAt: number
}

// ---------- 答复 ----------

export type ApprovalDecision = 'approve' | 'decline'

/** 手机的答复。设备服务原样转给发卡片的连接（litch/approval/answered） */
export interface ApprovalAnswer {
  /** 卡片号 */
  id: string
  /** 选的账号（卡片里的 ref）；拒绝时是 null */
  ref: string | null
  decision: ApprovalDecision
  /** 定时任务的卡片上勾了“以后直接用这个账号”；别的卡片一律 false */
  remember: boolean
  /** 手机号（devicePairing 的那个） */
  phoneId: string
  /** 手机名，只用来显示，不在签名里；桌面端第一次记下这台手机时用它 */
  phoneName?: string
  /** 批准公钥：32 字节，标准 base64 */
  approvalKey: string
  /** 对 approvalSignedText 的 ed25519 签名，标准 base64 */
  signature: string
}

/**
 * 形状对不对（设备服务转交前、桌面端验签前都查）：字段齐全、类型和格式对、拒绝时 ref 是 null、
 * 批准时 ref 不是 null。不验签名
 */
export function isApprovalAnswer(value: unknown): value is ApprovalAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !TOKEN.test(v.id)) return false
  if (v.decision !== 'approve' && v.decision !== 'decline') return false
  if (v.decision === 'decline' ? v.ref !== null : typeof v.ref !== 'string' || !REF.test(v.ref))
    return false
  if (typeof v.remember !== 'boolean') return false
  if (v.decision === 'decline' && v.remember) return false
  if (typeof v.phoneId !== 'string' || !PHONE_ID.test(v.phoneId)) return false
  if (v.phoneName !== undefined && typeof v.phoneName !== 'string') return false
  if (typeof v.approvalKey !== 'string' || !APPROVAL_KEY.test(v.approvalKey)) return false
  return typeof v.signature === 'string' && SIGNATURE.test(v.signature)
}

/** 卡片号、随机数、桌面端号的格式 */
export const isApprovalToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN.test(value)
/** 账号 ref 的格式 */
export const isApprovalRef = (value: unknown): value is string =>
  typeof value === 'string' && REF.test(value)
/** 批准公钥的格式（32 字节的标准 base64） */
export const isApprovalKey = (value: unknown): value is string =>
  typeof value === 'string' && APPROVAL_KEY.test(value)

// ---------- 方法 ----------

/** 方法名的共同前缀：聚合面按它把请求交给设备层 */
export const APPROVAL_PREFIX = 'litch/approval/'

/**
 * 桌面端 → 设备：挂一张卡片。同一条连接用同一个卡片号再开一次是换掉内容；别的连接已经用了这个号回 duplicate。
 * 要求这条连接握手时声明了 clientApprovals（不然回 undeclared）；过期时间已过回 expired。
 */
export const APPROVAL_OPEN = 'litch/approval/open'
export type ApprovalOpenParams = ApprovalCard
export type ApprovalOpenResponse = Record<string, never>

/** 桌面端 → 设备：收掉（桌面端答了、回合结束、过期）。只有发卡片的那条连接能收；没有这张卡片也回成功 */
export const APPROVAL_CLOSE = 'litch/approval/close'
export interface ApprovalCloseParams {
  id: string
}
export type ApprovalCloseResponse = Record<string, never>

/** 手机 → 设备：现在挂着的卡片，给了 threadId 只回这个会话的。先开的在前 */
export const APPROVAL_LIST = 'litch/approval/list'
export interface ApprovalListParams {
  threadId?: string
}
export interface ApprovalListResponse {
  data: ApprovalCardView[]
}

/**
 * 手机 → 设备：答一张卡片。设备服务只查形状（isApprovalAnswer）和卡片还在不在，原样转给发卡片的连接；
 * 卡片不因此收掉（桌面端验过签、答完了自己 close），验不过的桌面端丢掉、卡片接着等。
 * 没有这张卡片（收掉了、过期了、从没有过）回 unknownApproval；同一张卡片答太多次回 tooMany
 */
export const APPROVAL_ANSWER = 'litch/approval/answer'
export type ApprovalAnswerParams = ApprovalAnswer
export type ApprovalAnswerResponse = Record<string, never>

/** 一张卡片最多转交多少次答复（防设备上的代理拿它刷屏），再答回 tooMany */
export const APPROVAL_ANSWERS_MAX = 8

// ---------- 通知 ----------

/** 设备 → 声明了 clientApprovals 的连接：这个会话挂着的卡片变了，带这个会话现在的全部（没有了是空的） */
export const APPROVAL_CHANGED = 'litch/approval/changed'
export interface ApprovalChangedNotification {
  threadId: string
  data: ApprovalCardView[]
}

/** 设备 → 发卡片的那条连接：手机的答复，原样 */
export const APPROVAL_ANSWERED = 'litch/approval/answered'
export type ApprovalAnsweredNotification = ApprovalAnswer

// ---------- 错误 ----------

/** JSON-RPC 错误的 data.reason 取这些。参数形状不对回 -32602、不带原因；unknownApproval 也是 -32602，其余 -32000 */
export const APPROVAL_ERROR = {
  /** 没有这张卡片（收掉了、过期了、从没有过） */
  unknownApproval: 'unknownApproval',
  /** 别的连接已经用了这个卡片号 */
  duplicate: 'duplicate',
  /** open 时过期时间已经过了 */
  expired: 'expired',
  /** 这条连接挂的卡片太多，或者这张卡片答的次数太多 */
  tooMany: 'tooMany',
  /** 发卡片的连接握手时没有声明 clientApprovals */
  undeclared: 'undeclared',
} as const
export type ApprovalErrorReason = (typeof APPROVAL_ERROR)[keyof typeof APPROVAL_ERROR]
