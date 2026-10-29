// 剧本自带的小仓库；无第三方依赖，初始四个测试中恰好一个失败。
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function command(cwd, env, executable, args) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  }
}

export function git(cwd, env, ...args) {
  const result = command(cwd, env, 'git', args)
  if (result.status !== 0) throw new Error(`git ${args[0]}：${result.stderr || result.error}`)
  return result.stdout.trimEnd()
}

export function createTodo(cwd, env) {
  mkdirSync(cwd, { recursive: true })
  const files = {
    'package.json': JSON.stringify(
      {
        name: 'todo-lite',
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    ),
    '.gitignore': 'todos.json\n',
    'todo.mjs': `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
export function list(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
}
export function add(path, text) {
  const todos = list(path)
  todos.push({ text, done: false })
  writeFileSync(path, JSON.stringify(todos, null, 2))
}
export function remove(path, index) {
  const todos = list(path)
  // 已知问题：越界删除没有报错。
  todos.splice(index, 1)
  writeFileSync(path, JSON.stringify(todos, null, 2))
}
`,
    'cli.mjs': `import { add, list, remove } from './todo.mjs'
const [action, ...args] = process.argv.slice(2)
const path = 'todos.json'
if (action === 'add') add(path, args.join(' '))
else if (action === 'remove') remove(path, Number(args[0]))
else if (action === 'list') console.log(JSON.stringify(list(path), null, 2))
else { console.error('用法：node cli.mjs add <文字> | remove <从零开始的编号> | list'); process.exitCode = 1 }
`,
    'todo.test.mjs': `import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { add, list, remove } from './todo.mjs'
function data(t) {
  const dir = mkdtempSync(join(tmpdir(), 'todo-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'todos.json')
}
test('空列表', t => assert.deepEqual(list(data(t)), []))
test('添加后可以读回', t => {
  const path = data(t); add(path, '买牛奶')
  assert.deepEqual(list(path), [{ text: '买牛奶', done: false }])
})
test('删除已有项目', t => {
  const path = data(t); add(path, '买牛奶'); remove(path, 0)
  assert.deepEqual(list(path), [])
})
test('越界删除应报错', t => assert.throws(() => remove(data(t), 99), RangeError))
`,
    'README.md': `# todo-lite

一个无需依赖的 Node 待办命令行。数据存当前目录 todos.json。

用法：node cli.mjs add 买牛奶；node cli.mjs list；node cli.mjs remove 0。
检查：node --test。现有四个单测，其中越界删除应报错的测试失败。

## 路线图

0.2：修掉越界删除没有报错的已知 bug，加导出功能。
导出格式待定：CSV 便于表格软件打开；JSON 能保留布尔类型，适合备份和程序处理。
0.3：后续再规划。
`,
    'AGENTS.md': `所有修改只在本沙箱仓库及 Litch 分配的工作树内完成。不联网，不推送，不发布，不安装依赖。
测试使用仓库内临时目录：TMPDIR="$PWD/.test-tmp"，先 mkdir -p .test-tmp，完成后清理。
提交使用 git -c user.name=song -c user.email=slovx2@gmail.com commit，不添加署名行。
`,
  }
  for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, name), body)
  git(cwd, env, 'init', '-b', 'main')
  git(cwd, env, 'add', '.')
  git(
    cwd,
    env,
    '-c',
    'user.name=song',
    '-c',
    'user.email=slovx2@gmail.com',
    'commit',
    '-m',
    '初始化 todo-lite 0.1',
  )
  return command(cwd, env, process.execPath, ['--test'])
}

export const decisionFixture = (title, background) => ({
  kind: 'decision',
  decision: {
    title,
    background,
    options: [
      { id: 'json', label: 'JSON', description: '保留类型，便于程序使用。' },
      { id: 'csv', label: 'CSV', description: '便于表格软件打开。' },
    ],
    recommend: 'json',
    default: { kind: 'ask' },
    basis: [{ kind: 'file', target: 'README.md', label: '0.2 路线图' }],
  },
})
