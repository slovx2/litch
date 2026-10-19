// 配置助手按钮往输入框里放的那一句（14 号设计第五节）。只有逻辑，测试直接引用（packages/ui/test/assist.test.mjs）。
import type { MessageExtra, SkillOption } from '@litch/core'

/** 产品手册的技能名 */
export const MANUAL_SKILL = 'litch-manual'

export interface AssistPrefill {
  lead: string
  extras: MessageExtra[]
}

/**
 * 有手册的技能（这个 harness 的技能单子里有 litch-manual）：放技能片，正文是一句“用手册帮我配置：”；
 * 没有（ACP 那几个，或者用户关了安装）：不放技能片，正文里写上手册的位置让模型自己去读；位置也不知道就只说一句
 */
export function assistPrefill(
  lang: 'zh-CN' | 'en',
  skill: Pick<SkillOption, 'name' | 'path'> | null,
  dir: string | null,
): AssistPrefill {
  const zh = lang === 'zh-CN'
  if (skill) {
    return {
      lead: zh ? '使用 Litch 产品手册帮我配置：' : 'Use the Litch manual to help me configure: ',
      extras: [{ kind: 'skill', name: skill.name, path: skill.path }],
    }
  }
  const file = dir ? `${dir.replace(/[/\\]+$/, '')}/SKILL.md` : null
  if (!file) {
    return {
      lead: zh ? '使用 Litch 产品手册帮我配置：' : 'Use the Litch manual to help me configure: ',
      extras: [],
    }
  }
  return {
    lead: zh
      ? `使用 Litch 产品手册（${file}）帮我配置：`
      : `Use the Litch manual (${file}) to help me configure: `,
    extras: [],
  }
}

/** 技能单子里的产品手册 */
export const manualSkillIn = (skills: readonly SkillOption[]): SkillOption | null =>
  skills.find((skill) => skill.name === MANUAL_SKILL) ?? null
