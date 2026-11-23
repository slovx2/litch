import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildSync, transformSync } from '../../../node_modules/esbuild/lib/main.js'

const moduleCore = { exports: {} }
const bundled = buildSync({
  stdin: {
    contents: `export {keys, explicitFileRef, pathTwin, sessionFileScope} from './packages/core/src/index.mts'`,
    resolveDir: new URL('../../..', import.meta.url).pathname,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
})
runInNewContext(bundled.outputFiles[0].text, { module: moduleCore, exports: moduleCore.exports })
const core = moduleCore.exports

function load(path, sources) {
  const module = { exports: {} }
  runInNewContext(
    transformSync(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      loader: 'tsx',
      format: 'cjs',
      jsx: 'automatic',
    }).code,
    {
      module,
      require: (name) => {
        assert.ok(name in sources, name)
        return sources[name]
      },
    },
  )
  return module.exports
}

for (const known of [false, true])
  test(`看板文件固定经理设备和会话，${known ? '使用工作树摘要' : '摘要未到用经理 cwd'}，根外路径仍可打开`, async () => {
    const manager = { deviceId: 'remote', id: 'm', threadId: 'manager-thread', cwd: '/srv/project' }
    const summary = known
      ? {
          id: manager.threadId,
          cwd: '/srv/worktree',
          workspaceId: 'project',
          worktree: { state: 'ready', path: '/srv/worktree' },
        }
      : undefined
    const reads = [],
      commands = [],
      opened = [],
      navigated = [],
      errors = []
    const values = new Map([
      [core.keys.device('remote'), { os: 'linux', connection: 'online' }],
      [core.keys.summary('remote', manager.threadId), summary],
      [core.keys.workspaces('remote'), [{ id: 'project', roots: ['/srv/project'] }]],
    ])
    const useKey = (key) => {
      reads.push(key)
      return values.get(key)
    }
    const channel = {
      command: async (name, args) => {
        commands.push([name, args])
        return {
          status: 'ready',
          candidates: [{ root: '/tmp', path: '/tmp/result.md', kind: 'file' }],
        }
      },
    }
    const react = {
      createContext: () => ({}),
      useContext: () => null,
      useMemo: (fn) => fn(),
      useState: (value) => [
        value,
        (next) => {
          if (typeof next === 'string' && next) errors.push(next)
        },
      ],
    }
    const jsx = {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
    }
    const files = load('../src/transcript/FileLinks.tsx', {
      '@litch/core': core,
      react,
      'react/jsx-runtime': jsx,
      '../app/services.tsx': { useKey, useServices: () => ({ channel }) },
      '../app/appearance.ts': { useT: () => (key) => key },
      '../files/FileLinkDialog.tsx': {},
      './ExternalLink.tsx': {},
      '../files/state.ts': { openInFiles: (value) => opened.push(value) },
    })
    const { RelationLink } = load('../src/manager/RelationLink.tsx', {
      '@litch/core': core,
      react,
      'react/jsx-runtime': jsx,
      '../app/services.tsx': { useKey, useServices: () => ({ channel, replica: { store: {} } }) },
      '../app/appearance.ts': { useT: () => (key) => key },
      '../app/actions.ts': {},
      '../app/errors.ts': { reasonOf: String },
      '../files/FileLinkDialog.tsx': {},
      '../transcript/ExternalLink.tsx': {},
      '../transcript/FileLinks.tsx': files,
      './BoardMarkdown.tsx': {},
      './BoardReferences.tsx': { BoardReferencesContext: {} },
    })
    const tree = RelationLink({ manager, target: { kind: 'file', target: '/tmp/result.md#L12' } })
    tree.props.children[0].props.onClick()
    await new Promise(setImmediate)
    assert.deepEqual(errors, [])
    assert.equal(commands.length, 1)
    assert.equal(commands[0][0], 'files.resolve')
    assert.equal(commands[0][1].deviceId, 'remote')
    assert.equal(commands[0][1].root, known ? '/srv/worktree' : manager.cwd)
    assert.equal(commands[0][1].ref.path, '/tmp/result.md')
    assert.equal(opened.length, 1)
    assert.equal(opened[0].deviceId, 'remote')
    assert.equal(opened[0].sessionId, manager.threadId)
    assert.equal(opened[0].line, 12)
    assert.equal(opened[0].root, '/tmp')

    const { useBoardFile } = load(
      '../../../apps/mobile/src/screens/managers/use-board-reference.ts',
      {
        '@litch/core': core,
        '@react-navigation/native': {
          useNavigation: () => ({ navigate: (...args) => navigated.push(args) }),
        },
        '../../shell/services': { useKey },
        '../../ui/i18n': { useT: () => (key) => key },
      },
    )
    useBoardFile(manager)('/tmp/result.md#L12')
    assert.equal(navigated[0][0], 'Files')
    assert.equal(navigated[0][1].deviceId, 'remote')
    assert.equal(navigated[0][1].sessionId, manager.threadId)
    assert.equal(navigated[0][1].root, known ? '/srv/worktree' : manager.cwd)
    assert.equal(navigated[0][1].path, '/tmp/result.md')
    assert.equal(navigated[0][1].line, 12)
    assert.ok(
      reads.every((key) => !key.includes('local')),
      '不读取本机副本或本机工作区',
    )
  })
