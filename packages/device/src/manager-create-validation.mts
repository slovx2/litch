import type { ManagerCreateParams } from '../../protocol/src/manager.mjs'
import { managerSelectionIssue } from '../../protocol/src/manager-validation.mjs'
import type { EngineLink } from './engine-link.mjs'
import { invalidSetting } from './manager-validate.mjs'
import { type CatalogModel, modelCatalog } from './session-options.mjs'
import type { SessionTree } from './session-tree.mjs'

/** 提交时再核对一次：用户停在表单期间，引擎配置或型号目录可能已经改变。 */
export async function validateManagerRuntime(
  tree: SessionTree,
  params: ManagerCreateParams,
): Promise<void> {
  const same = !params.dispatch.harness || params.dispatch.harness === params.harness
  const targets = [
    { prefix: '', harness: params.harness, model: params.model, effort: params.effort },
    {
      prefix: 'dispatch.',
      harness: params.dispatch.harness ?? params.harness,
      model: params.dispatch.model ?? (same ? params.model : null),
      effort: params.dispatch.effort,
    },
  ]
  for (const target of targets) {
    let link: EngineLink
    try {
      link = await tree.link(target.harness)
    } catch (error) {
      invalidSetting({
        field: `${target.prefix}harness`,
        reason: 'unavailableHarness',
        message: String(error),
      })
    }
    if (!target.model && !target.effort) continue
    let catalog: CatalogModel[]
    try {
      catalog = (await modelCatalog(link)).filter((entry) => !entry.hidden)
    } catch (error) {
      invalidSetting({
        field: `${target.prefix}model`,
        reason: 'catalogUnavailable',
        message: String(error),
      })
    }
    const issue = managerSelectionIssue(catalog, target.model, target.effort, target.prefix)
    if (issue) invalidSetting(issue)
  }
}
