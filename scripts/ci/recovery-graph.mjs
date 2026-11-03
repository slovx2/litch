// 只解析本地受审工作流，不执行表达式；不支持的动态矩阵/外部workflow一律拒绝。
import assert from 'node:assert/strict'
import { parseDocument } from 'yaml'
import { evidenceHash } from './recovery-policy.mjs'

const summaries = new Set([
  'ci.yml:report',
  'full.yml:report',
  'full.yml:adapters',
  'gate.yml:result',
  'release.yml:seal',
  'recovery-fixture.yml:report',
])
const list = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])

export function buildRecoveryGraph(path, jobs, readWorkflow) {
  const actual = new Map(jobs.map((job) => [job.name, job]))
  assert.equal(actual.size, jobs.length, '实际job名不能重复')
  const nodes = new Map()
  const documents = {}
  function visit(file, prefix = '', ancestry = []) {
    assert.match(file, /^\.github\/workflows\/[a-z0-9-]+\.yml$/)
    assert.ok(!ancestry.includes(file) && ancestry.length < 8, 'workflow调用环或过深')
    const source = readWorkflow(file)
    documents[file] = evidenceHash(source)
    const parsed = parseDocument(source, { uniqueKeys: true })
    assert.equal(parsed.errors.length, 0, 'workflow YAML错误')
    const workflow = parsed.toJS({ maxAliasCount: 0 })
    assert.ok(workflow.jobs && typeof workflow.jobs === 'object')
    const groups = new Map()
    const specs = Object.entries(workflow.jobs)
    for (const [key, spec] of specs) {
      assert.match(key, /^[a-zA-Z0-9_-]+$/)
      assert.equal(spec.name, undefined, '自定义job名尚未审查')
      const name = prefix + key
      let members
      if (spec.uses) {
        assert.match(spec.uses, /^\.\/\.github\/workflows\/[a-z0-9-]+\.yml$/)
        assert.equal(spec.strategy, undefined, '可复用workflow矩阵尚未审查')
        const placeholder = actual.get(name)
        if (placeholder) {
          assert.equal(placeholder.conclusion, 'skipped', '仅允许整组跳过占位')
          const children = visit(spec.uses.slice(2), `${name} / `, [...ancestry, file])
          members = [...children, name]
          nodes.set(name, {
            name,
            file,
            key,
            needs: new Set(children),
            role: 'call',
            actual: placeholder,
          })
        } else {
          members = visit(spec.uses.slice(2), `${name} / `, [...ancestry, file])
        }
      } else {
        const matrix = spec.strategy?.matrix
        let combinations = [[]]
        if (matrix !== undefined) {
          assert.ok(matrix && typeof matrix === 'object' && !Array.isArray(matrix))
          for (const [axis, values] of Object.entries(matrix)) {
            assert.ok(!['include', 'exclude'].includes(axis), '复杂矩阵尚未审查')
            assert.ok(Array.isArray(values) && values.length > 0)
            assert.ok(
              values.every(
                (v) =>
                  ['string', 'number', 'boolean'].includes(typeof v) && !String(v).includes('${{'),
              ),
            )
            combinations = combinations.flatMap((prior) => values.map((v) => [...prior, v]))
            assert.ok(combinations.length <= 64, '矩阵过大')
          }
        }
        const placeholder = matrix && actual.get(name)
        if (placeholder) assert.equal(placeholder.conclusion, 'skipped', '矩阵占位必须跳过')
        members = placeholder
          ? [name]
          : combinations.map((values) => (values.length ? `${name} (${values.join(', ')})` : name))
        for (const member of members) {
          const identity = `${file.split('/').at(-1)}:${key}`
          const role = summaries.has(identity)
            ? 'summary'
            : identity === 'mac-priority.yml:ready'
              ? 'coordinator'
              : 'work'
          assert.ok(!nodes.has(member), '重复逻辑job')
          const mac =
            JSON.stringify(spec['runs-on'] ?? '').includes('macos') ||
            (matrix?.os ?? []).some((os) => String(os).startsWith('macos'))
          const preparations = (spec.steps ?? []).flatMap((step, index) =>
            step.uses
              ? [{ number: index + 2, name: step.name ?? `Run ${step.uses}`, uses: step.uses }]
              : [],
          )
          const guard = (spec.steps ?? []).find((step) => step.name === '阻断失败的上游')
          const dependencyGuard =
            guard?.run?.trim() === "echo '::error::LITCH_RECOVERY_UPSTREAM_FAILURE'\nexit 1" ||
            guard?.run?.trim() ===
              'if [ "$LINUX" != success ] || [ "$MACOS" != success ]; then\n  echo \'::error::LITCH_RECOVERY_UPSTREAM_FAILURE\'\n  exit 1\nfi'
          const signingWait = (spec.steps ?? []).some(
            (step) =>
              step.name === '同候选签名成功后再申请Mac' &&
              step.run?.trim() === 'node scripts/ci/mac-priority.mjs',
          )
          nodes.set(member, {
            name: member,
            file,
            key,
            role,
            mac,
            preparations,
            dependencyGuard,
            signingWait,
            needs: new Set(),
            actual: actual.get(member) ?? null,
          })
        }
      }
      groups.set(key, members)
    }
    for (const [key, spec] of specs) {
      for (const need of list(spec.needs)) {
        assert.ok(typeof need === 'string' && groups.has(need), '未知needs')
        for (const member of groups.get(key))
          for (const upstream of groups.get(need)) nodes.get(member).needs.add(upstream)
      }
    }
    return [...groups.values()].flat()
  }
  visit(path)
  for (const job of jobs) assert.ok(nodes.has(job.name), `实际job不在受审DAG内：${job.name}`)
  // API等待签名的依赖不是GitHub的声明边；单列，不能误以为job-rerun会自动恢复协调器。
  if (path === '.github/workflows/release.yml') {
    assert.ok(nodes.has('desktop-macos'))
    for (const node of nodes.values()) {
      if (node.role === 'coordinator') {
        node.needs.add('desktop-macos')
        node.apiWait = true
      }
    }
  }
  const ancestryCache = new Map()
  function ancestors(name, trail = []) {
    assert.ok(!trail.includes(name), 'needs依赖环')
    if (ancestryCache.has(name)) return ancestryCache.get(name)
    const result = new Set()
    for (const upstream of nodes.get(name).needs) {
      result.add(upstream)
      for (const ancestor of ancestors(upstream, [...trail, name])) result.add(ancestor)
    }
    ancestryCache.set(name, result)
    return result
  }
  const graph = [...nodes.values()].map(({ needs, ...node }) => ({
    ...node,
    needs: [...needs].sort(),
    ancestors: [...ancestors(node.name)].sort(),
  }))
  return {
    nodes: graph,
    digest: evidenceHash({ documents, graph: graph.map(({ actual: _actual, ...node }) => node) }),
  }
}

export function recoveryClosure(graph, roots) {
  const names = new Set(roots.map((root) => root.name))
  return graph.nodes.filter(
    (node) => names.has(node.name) || node.ancestors.some((name) => names.has(name)),
  )
}
