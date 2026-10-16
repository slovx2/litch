// 协议兼容性测试里各入口自己要给的那一部分：会话怎么建、模型这一回合怎么演。
// 流程和回放是三个入口共用的（standard-flow.mts、desktop-replay.mts），只有“怎么让模型去调一个要审批的工具”
// 这类事各入口不一样：各包的 upstream-compat.test.mts 起自己的服务和回环上的假模型，实现这个接口。

/** 一种回合：plain 只说一句话；approval 调一个要审批的工具；question 向用户提问；slow 慢慢说，好让测试来得及打断 */
export type SceneName = 'plain' | 'approval' | 'question' | 'slow'

export interface TurnScript {
  /** 这一回合用户说的话 */
  prompt: string
  /** 并进 turn/start 参数里的（比如计划模式） */
  params?: Record<string, unknown>
  /** slow 回合：模型的话是一段一段流出来的。是的话等头一段到了再打断，不是的话回合一开始就打断 */
  streams?: boolean
  /** slow 回合被打断之后调：放掉还压着的模型应答 */
  release?: () => void
}

/**
 * 计划模式，照官方桌面端的做法走：计划模式的回合里模型交一份计划，回合带着计划条目正常结束；
 * 选了执行是一个协作模式切回 default 的新回合。两个回合用户说的话和协作模式由流程照桌面端的样子给，
 * 这里只排模型的应答。
 */
export interface PlanScene {
  /** 协作模式里带的模型（上游结构里是必填的字符串） */
  model: string
  /** 排好计划模式那一回合模型的应答：交一份计划 */
  plan(): void
  /** 排好选了执行之后那一回合模型的应答 */
  implement(): void
}

export interface EntryScene {
  /** 基线清单里这个入口的名字 */
  entry: string
  /** 会话的工作目录，临时的 */
  cwd: string
  /** 新建会话时的参数，不含 cwd */
  threadStart: Record<string, unknown>
  /** approval 回合里审批走的是哪个服务端请求 */
  approvalMethod: string
  /** 把模型这一回合的应答排好。这个入口演不了这种回合时返回 null */
  script(name: SceneName): TurnScript | null | Promise<TurnScript | null>
  /** 计划模式。没有这一项的入口不接计划模式 */
  planMode?: PlanScene
}

/**
 * 官方桌面端对各种服务端请求的答法，照协议里各自的应答结构写：审批一律同意、提问选第一个选项、
 * MCP 征询拒绝、客户端工具回一个空的失败结果。别的请求不认识，抛错（客户端会回 JSON-RPC 错误）。
 */
export function standardAnswer(method: string, params: any): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'accept' }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }
    case 'item/tool/requestUserInput':
      return {
        answers: Object.fromEntries(
          (params.questions as any[]).map((question) => [
            question.id,
            { answers: question.options?.length ? [question.options[0].label] : ['好'] },
          ]),
        ),
      }
    case 'mcpServer/elicitation/request':
      return { action: 'decline' }
    case 'item/tool/call':
      return { success: false, contentItems: [] }
    default:
      throw new Error(`没料到的服务端请求 ${method}`)
  }
}

export const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }]
