import type {
  AutomationPointerSample,
  AutomationSurface,
} from '../../automation-contracts/src/automation-surface.mjs'
import type { ChromeGrant } from '../../automation-contracts/src/litch/chrome-browser.mjs'
import { ChromeFault, cdp, documentStamp, type ExtensionState, requireGrant } from './state.mjs'

interface PointerWorld {
  contextId: number
  generation: number
  seq: number
  sample?: AutomationPointerSample
}
const runtimeWorlds = new WeakMap<ExtensionState, Map<string, PointerWorld>>()
function worldsOf(state: ExtensionState): Map<string, PointerWorld> {
  let worlds = runtimeWorlds.get(state)
  if (!worlds) {
    worlds = new Map()
    runtimeWorlds.set(state, worlds)
  }
  return worlds
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ChromeFault(
                'targetUnavailable',
                'The page did not respond to pointer preparation. Wait for load and take a fresh snapshot; if it remains unresponsive, reload it. Foreground focus is not required. Check the input receipt before retrying.',
              ),
            ),
          1200,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function evaluate<T>(
  state: ExtensionState,
  grant: ChromeGrant,
  world: PointerWorld,
  expression: string,
): Promise<T> {
  const reply = await bounded(
    cdp(state, grant.tabId, 'Runtime.evaluate', {
      contextId: world.contextId,
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: 1000,
    }),
  )
  if (reply.exceptionDetails)
    throw new ChromeFault(
      'staleDocument',
      'The pointer document or viewport changed. Take a fresh snapshot.',
    )
  return reply.result?.value as T
}
async function worldOf(state: ExtensionState, grant: ChromeGrant): Promise<PointerWorld> {
  const generation = state.generations.get(grant.tabId) ?? 0
  const old = worldsOf(state).get(grant.leaseId)
  if (old?.generation === generation) return old
  if (old) await disposePointer(state, grant)
  const { frameTree } = await cdp(state, grant.tabId, 'Page.getFrameTree')
  const { executionContextId } = await cdp(state, grant.tabId, 'Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: `litch-chrome-${grant.leaseId}`,
    grantUniveralAccess: false,
  })
  const world: PointerWorld = { contextId: executionContextId, generation, seq: 0 }
  worldsOf(state).set(grant.leaseId, world)
  await evaluate(state, grant, world, state.pointerSource)
  await evaluate(
    state,
    grant,
    world,
    `__litchChromePointer.configure(${JSON.stringify({ surfaceId: `chrome:${grant.tabId}`, executorId: state.epoch, generation, geometryRevision: 0, kind: 'browserViewport', width: 1, height: 1 })},${JSON.stringify(grant.leaseId)})`,
  )
  await requireGrant(state, grant.leaseId, generation)
  return world
}

async function preparePointer(
  state: ExtensionState,
  grant: ChromeGrant,
  x?: number,
  y?: number,
  kind: AutomationPointerSample['kind'] = 'click',
): Promise<void> {
  const before = await documentStamp(state, grant)
  const world = await worldOf(state, grant)
  const measured = await evaluate<{ surface: AutomationSurface }>(
    state,
    grant,
    world,
    '__litchChromePointer.geometry()',
  )
  const position = x !== undefined && y !== undefined ? { x, y } : undefined
  if (
    position &&
    (!Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      position.x < 0 ||
      position.y < 0 ||
      position.x >= measured.surface.width ||
      position.y >= measured.surface.height)
  )
    throw new ChromeFault('invalid', 'Pointer coordinates are outside the current viewport.')
  const sample: AutomationPointerSample = {
    ...measured.surface,
    actionId: crypto.randomUUID(),
    seq: ++world.seq,
    timeUs: Math.round(performance.now() * 1000),
    phase: 'planned',
    kind,
    ...(position ? { position } : {}),
    pressed: false,
  }
  world.sample = sample
  type Receipt = { sample: AutomationPointerSample; result: string }
  let receipt = await evaluate<Receipt>(
    state,
    grant,
    world,
    `__litchChromePointer.prepare(${JSON.stringify(sample)})`,
  )
  // 动画与页面计时器都可能因后台节流停住。由扩展计时，只轮询同步状态；
  // 到点跳过呈现等待，随后照常核对文档、租约与几何，不吞页面/CDP 错误。
  const deadline = performance.now() + 200
  while (receipt?.result === 'pending' && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    receipt = await evaluate<Receipt>(state, grant, world, '__litchChromePointer.arrival()')
  }
  if (
    !receipt ||
    receipt.sample.actionId !== sample.actionId ||
    receipt.sample.seq !== sample.seq ||
    !['arrived', 'hidden', 'timedOut', 'pending'].includes(receipt.result)
  )
    throw new ChromeFault(
      'staleDocument',
      'The pointer preparation was superseded. No input was dispatched.',
    )
  await verifyPointer(state, grant, world)
  if (before !== (await documentStamp(state, grant)))
    throw new ChromeFault(
      'staleDocument',
      'The document changed while preparing input. No input was dispatched.',
    )
}
export async function planPointer(
  state: ExtensionState,
  grant: ChromeGrant,
  x?: number,
  y?: number,
  kind: AutomationPointerSample['kind'] = 'click',
): Promise<void> {
  try {
    await preparePointer(state, grant, x, y, kind)
  } catch (error) {
    await disposePointer(state, grant, 'failed')
    throw error
  }
}
async function verifyPointer(
  state: ExtensionState,
  grant: ChromeGrant,
  world: PointerWorld,
): Promise<void> {
  await requireGrant(state, grant.leaseId, world.generation)
  const current = await evaluate<{ surface: AutomationSurface }>(
    state,
    grant,
    world,
    '__litchChromePointer.geometry()',
  )
  if (!world.sample || current.surface.geometryRevision !== world.sample.geometryRevision)
    throw new ChromeFault(
      'staleDocument',
      'The viewport changed. Take a fresh screenshot or snapshot before input.',
    )
}
export async function pointerCommand(
  state: ExtensionState,
  grant: ChromeGrant,
  method: string,
  params: Record<string, unknown>,
  dispatch: () => Promise<unknown>,
): Promise<unknown> {
  if (!method.startsWith('Input.')) return dispatch()
  const mouse = method === 'Input.dispatchMouseEvent'
  let world = worldsOf(state).get(grant.leaseId)
  let x = typeof params.x === 'number' ? params.x : undefined
  let y = typeof params.y === 'number' ? params.y : undefined
  if (!mouse) {
    world = await worldOf(state, grant)
    const focus = await evaluate<{ x: number; y: number } | null>(
      state,
      grant,
      world,
      '__litchChromePointer.focusPoint()',
    )
    x = focus?.x
    y = focus?.y
  }
  if (
    !mouse ||
    !world?.sample ||
    world.sample.phase === 'completed' ||
    world.sample.position?.x !== x ||
    world.sample.position?.y !== y
  ) {
    await planPointer(
      state,
      grant,
      x,
      y,
      !mouse ? 'semantic' : params.type === 'mouseWheel' ? 'scroll' : 'click',
    )
    world = worldsOf(state).get(grant.leaseId)
  }
  if (!world?.sample) throw new ChromeFault('staleDocument', 'Pointer state expired.')
  await verifyPointer(state, grant, world)
  try {
    const result = await dispatch()
    const completed = !mouse || params.type === 'mouseReleased' || params.type === 'mouseWheel'
    world.sample = {
      ...world.sample,
      seq: ++world.seq,
      timeUs: Math.round(performance.now() * 1000),
      phase: completed ? 'completed' : 'dispatched',
      pressed: params.type === 'mousePressed',
    }
    // 输入已发生后，光标呈现失败不重放输入；外层仍执行文档/来源复核。
    await evaluate(
      state,
      grant,
      world,
      `void __litchChromePointer.update(${JSON.stringify(world.sample)}); true`,
    ).catch(() => {})
    return result
  } catch (error) {
    await disposePointer(state, grant, 'failed')
    throw error
  }
}
export async function withoutPointer<T>(
  state: ExtensionState,
  grant: ChromeGrant,
  capture: () => Promise<T>,
): Promise<T> {
  const world = worldsOf(state).get(grant.leaseId)
  if (!world) return capture()
  try {
    await evaluate(state, grant, world, '__litchChromePointer.hide()')
    await requireGrant(state, grant.leaseId)
    return await capture()
  } finally {
    await evaluate(state, grant, world, '__litchChromePointer.restore()').catch(() => {})
  }
}
export async function disposePointer(
  state: ExtensionState,
  grant: ChromeGrant,
  phase: 'failed' | 'cancelled' = 'cancelled',
): Promise<void> {
  const world = worldsOf(state).get(grant.leaseId)
  worldsOf(state).delete(grant.leaseId)
  if (!world) {
    await clearPointerNodes(state, grant.tabId).catch(() => {})
    return
  }
  if (world.sample && world.sample.phase !== 'completed') {
    world.sample = {
      ...world.sample,
      phase,
      pressed: false,
      seq: ++world.seq,
      timeUs: Math.round(performance.now() * 1000),
    }
    await evaluate(
      state,
      grant,
      world,
      `void __litchChromePointer.update(${JSON.stringify(world.sample)}); true`,
    ).catch(() => {})
  }
  await evaluate(state, grant, world, '__litchChromePointer.dispose()').catch(() => {})
  await clearPointerNodes(state, grant.tabId).catch(() => {})
}

/** 认领/交还时只移除自动化自己的 DOM 标记，不恢复外部撤掉的 debugger。 */
export async function clearPointerNodes(state: ExtensionState, tabId: number): Promise<void> {
  await bounded(
    cdp(state, tabId, 'Runtime.evaluate', {
      expression:
        "document.querySelectorAll('[data-litch-chrome-pointer]').forEach(node => node.remove())",
      timeout: 1000,
    }),
  )
}

/** worker 被强停后只清理已登记的本扩展 host；不恢复租约。 */
export async function cleanupPointer(
  state: ExtensionState,
  tabId: number,
  leaseId: string,
): Promise<void> {
  try {
    const { frameTree } = await cdp(state, tabId, 'Page.getFrameTree')
    const { executionContextId } = await cdp(state, tabId, 'Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: `litch-chrome-${leaseId}`,
    })
    await bounded(
      cdp(state, tabId, 'Runtime.evaluate', {
        contextId: executionContextId,
        expression: `globalThis.__litchChromePointer?.dispose(); document.querySelectorAll('[data-litch-chrome-pointer]').forEach(node => { if(node.getAttribute('data-litch-chrome-pointer') === ${JSON.stringify(leaseId)}) node.remove() })`,
        timeout: 1000,
      }),
    )
  } catch {
    /* 文档已销毁或 debugger 已被 Chrome 撤销时，没有可清理的旧 world。 */
  }
}
