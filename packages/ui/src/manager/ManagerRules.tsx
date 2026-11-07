// 概览页里的“经理设定”卡：用户写给经理的规则，照原样换行、按 Markdown 排，长了先折起。
// 规则一般很长，不再压成一行常驻在看板顶上；编辑仍走经理的设置表单。
import type { ManagerView } from '../../../core/src/model-manager.mts'
import { useT } from '../app/appearance.ts'
import { FoldText } from '../tree/BriefSections.tsx'
import { BoardMarkdown } from './BoardMarkdown.tsx'

export function ManagerRules({
  manager,
  onEdit,
}: {
  manager: ManagerView
  /** 没有（经理已结束、设备离线）时不出编辑按钮 */
  onEdit?: (() => void) | undefined
}) {
  const t = useT()
  if (!manager.rules?.trim()) return null
  return (
    <section className="mg-card mg-rules" data-manager-rules="">
      <header>
        <h3 className="grow">{t('manager.prompt')}</h3>
        {onEdit ? (
          <button
            type="button"
            className="btn ghost"
            data-act="manager-rules-edit"
            onClick={onEdit}
          >
            {t('manager.rulesEdit')}
          </button>
        ) : null}
      </header>
      <FoldText text={manager.rules} Markdown={BoardMarkdown} />
    </section>
  )
}
