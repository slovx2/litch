import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildCliConfigLayer,
  cliConfigArgs,
  mergeConfigLayers,
  parseCliOverride,
} from '../src/cli-config.mjs'
import { bwrapFileSystemArgs, sandboxCommand } from '../src/command-sandbox.mjs'
import {
  compileFileSystemRules,
  type FileSystemRules,
  legacySandboxPolicy,
  pathAccess,
  profileSandboxMode,
  resolvePermissionProfile,
  validatePermissionsConfig,
} from '../src/permission-profiles.mjs'
import { deniedTool } from '../src/runtime-permissions.mjs'
import type { RuntimeTurnContext } from '../src/types.mjs'

// 用例里的目录：真实路径（macOS 的临时目录是 /var → /private/var 的链接，规则里存的是真实路径）
function scratch(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)))
}

function compile(
  permissions: Record<string, unknown>,
  id: string,
  cwd: string,
  roots: string[] | null = null,
): FileSystemRules {
  return compileFileSystemRules(
    { id, profile: resolvePermissionProfile(permissions, id), runtimeWorkspaceRoots: roots },
    cwd,
  )
}

test('PROFILE-001：-c 照 codex 解析，只收白名单里的键，后给的覆盖先给的', () => {
  assert.deepEqual(
    cliConfigArgs([
      'app-server',
      '-c',
      'a=1',
      '--listen',
      'stdio://',
      '--config=b=2',
      '--config',
      'c=3',
    ]),
    ['a=1', 'b=2', 'c=3'],
  )
  assert.deepEqual(parseCliOverride('approval_policy="never"'), ['approval_policy', 'never'])
  // 不是合法 TOML 就当字符串，去掉两头的引号
  assert.deepEqual(parseCliOverride('sandbox_mode=read-only'), ['sandbox_mode', 'read-only'])
  assert.deepEqual(parseCliOverride('x={ "/a/b c" = "read", "/d" = "write" }'), [
    'x',
    { '/a/b c': 'read', '/d': 'write' },
  ])
  assert.throws(() => parseCliOverride('novalue'), /缺少“=”/)
  // 写坏了的表（TOML 解析失败）同样当字符串收下，到校验档位时报错，不会悄悄当成空档位
  const broken = buildCliConfigLayer(['permissions.p.filesystem={ "/srv" = "deny"'])
  assert.deepEqual(broken, { permissions: { p: { filesystem: '{ "/srv" = "deny' } } })
  assert.throws(
    () => validatePermissionsConfig({ ...broken, default_permissions: 'p' }),
    /-c|filesystem|档位/,
  )
  // 键里带 __proto__ 之类的段整条忽略，值里的也丢掉，都不会改到原型上
  const polluted = buildCliConfigLayer([
    'permissions.__proto__.polluted=true',
    'mcp_servers.constructor.prototype.x=1',
    'permissions.p={ __proto__ = { polluted = true }, extends = ":workspace" }',
  ])
  assert.deepEqual(polluted, { permissions: { p: { extends: ':workspace' } } })
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(Object.getPrototypeOf(mergeConfigLayers({}, polluted)), Object.prototype)
  const layer = buildCliConfigLayer([
    'approval_policy="on-request"',
    'approval_policy="never"',
    'model="gpt-5"',
    'features.hooks=true',
    'default_permissions="wakeqora-saas"',
    'permissions.wakeqora-saas.extends=":workspace"',
    'permissions.wakeqora-saas.filesystem={ "/srv" = "deny" }',
    'permissions.wakeqora-saas.network={ enabled = true, allow_local_binding = true }',
    'mcp_servers.docs={ command = "docs-mcp", args = ["--stdio"] }',
    'developer_instructions="照章办事"',
  ])
  assert.deepEqual(layer, {
    approval_policy: 'never',
    default_permissions: 'wakeqora-saas',
    permissions: {
      'wakeqora-saas': {
        extends: ':workspace',
        filesystem: { '/srv': 'deny' },
        network: { enabled: true, allow_local_binding: true },
      },
    },
    mcp_servers: { docs: { command: 'docs-mcp', args: ['--stdio'] } },
    developer_instructions: '照章办事',
  })
  // 叠在 config.json 上：表逐键合并，其余整个替换
  assert.deepEqual(
    mergeConfigLayers(
      { approval_policy: 'on-request', mcp_servers: { a: { command: 'a' } }, model: 'm' },
      { approval_policy: 'never', mcp_servers: { b: { command: 'b' } } },
    ),
    {
      approval_policy: 'never',
      mcp_servers: { a: { command: 'a' }, b: { command: 'b' } },
      model: 'm',
    },
  )
})

test('PROFILE-002：extends 照 codex 合并，内置父档位、成环、未定义与保留前缀', () => {
  const resolved = resolvePermissionProfile(
    {
      base: { extends: ':workspace', filesystem: { '/a': 'read' }, network: { enabled: true } },
      child: {
        extends: 'base',
        filesystem: { '/a': 'none', ':workspace_roots': { docs: 'read' } },
        workspace_roots: { '/extra': true, '/off': false },
      },
    },
    'child',
  )
  assert.deepEqual(resolved, {
    filesystem: {
      ':root': 'read',
      ':workspace_roots': { '.': 'write', docs: 'read' },
      ':slash_tmp': 'write',
      ':tmpdir': 'write',
      '/a': 'deny',
    },
    workspaceRoots: ['/extra'],
    networkEnabled: true,
  })
  assert.equal(profileSandboxMode(resolved), 'workspace-write')
  assert.equal(
    profileSandboxMode(resolvePermissionProfile({ ro: { extends: ':read-only' } }, 'ro')),
    'read-only',
  )
  assert.throws(() => resolvePermissionProfile({}, 'missing'), /未知权限配置/)
  assert.throws(
    () => resolvePermissionProfile({ a: { extends: 'b' }, b: { extends: 'a' } }, 'a'),
    /成环：a -> b -> a/,
  )
  assert.throws(
    () => resolvePermissionProfile({ a: { extends: 'nope' } }, 'a'),
    /继承的 nope 没有定义/,
  )
  assert.throws(
    () => resolvePermissionProfile({ a: { extends: ':danger-full-access' } }, 'a'),
    /不能继承内置档位 :danger-full-access/,
  )
  assert.throws(() => resolvePermissionProfile({ ':x': {} }, ':x'), /保留的“:”前缀/)
  assert.throws(
    () => resolvePermissionProfile({ a: { filesystem: { '/a': 'all' } } }, 'a'),
    /只能是 read、write 或 deny/,
  )
  assert.throws(
    () => resolvePermissionProfile({ a: { filesystem: { relative: 'read' } } }, 'a'),
    /必须是绝对路径/,
  )
  assert.throws(
    () => resolvePermissionProfile({ a: { filesystem: { '/a': { '../b': 'read' } } } }, 'a'),
    /不含 \. 和 \.\. 的相对路径/,
  )
  assert.throws(
    () => resolvePermissionProfile({ a: { filesystem: { ':root': { x: 'read' } } } }, 'a'),
    /不能带子路径/,
  )
  // deny 的 glob 还不支持，宁可报错也不悄悄放过
  assert.throws(
    () => resolvePermissionProfile({ a: { filesystem: { '/srv/**/*.env': 'deny' } } }, 'a'),
    /glob/,
  )
  assert.throws(
    () => resolvePermissionProfile({ a: { filesystem: { '/srv/*.txt': 'read' } } }, 'a'),
    /glob 只能用于 deny/,
  )
})

test('PROFILE-003：判定与 codex 的 resolve_access 一致（最深的为准，同深 deny > write > read）', () => {
  const cwd = scratch('profile-semantics')
  try {
    // 照搬 codex 的 resolve_access_for_local_path_with_cwd_uses_most_specific_entry，再加上 :root 可读
    const rules = compile(
      {
        p: {
          filesystem: {
            ':root': 'read',
            ':workspace_roots': { '.': 'write', docs: 'read', 'docs/private': 'deny' },
            [join(cwd, 'docs/private/public')]: 'write',
          },
        },
      },
      'p',
      cwd,
    )
    assert.equal(pathAccess(rules, cwd), 'write')
    assert.equal(pathAccess(rules, join(cwd, 'src/a.ts')), 'write')
    assert.equal(pathAccess(rules, join(cwd, 'docs')), 'read')
    assert.equal(pathAccess(rules, join(cwd, 'docs/private')), 'deny')
    assert.equal(pathAccess(rules, join(cwd, 'docs/private/x')), 'deny')
    assert.equal(pathAccess(rules, join(cwd, 'docs/private/public/y')), 'write')
    assert.equal(pathAccess(rules, '/etc/hosts'), 'read')
    // 同一路径不同写法给了两条：取最严的
    const tie = compile(
      { p: { extends: ':read-only', filesystem: { [cwd]: 'write', [`${cwd}/`]: 'deny' } } },
      'p',
      cwd,
    )
    assert.equal(pathAccess(tie, cwd), 'deny')
    // :workspace 继承来的：工作区根（runtimeWorkspaceRoots，没给是 cwd）和两个临时目录可写
    const other = scratch('profile-root')
    const saas = compile(
      { s: { extends: ':workspace', filesystem: { [join(cwd, 'secret')]: 'deny' } } },
      's',
      cwd,
      [cwd, other],
    )
    assert.equal(pathAccess(saas, join(other, 'f')), 'write')
    assert.equal(pathAccess(saas, realpathSync('/tmp')), 'write')
    assert.equal(pathAccess(saas, join(cwd, 'secret/f')), 'deny')
    assert.equal(saas.networkAccess, false)
    const projected = legacySandboxPolicy(saas)
    assert.equal(projected.type, 'workspaceWrite')
    assert.ok(projected.type === 'workspaceWrite' && projected.writableRoots.includes(other))
    // `~/` 按主目录展开，未知的特殊路径忽略
    const home = compile(
      { h: { extends: ':read-only', filesystem: { '~/.ssh': 'deny', ':future_path': 'write' } } },
      'h',
      cwd,
    )
    assert.equal(pathAccess(home, join(realpathSync(homedir()), '.ssh/id_rsa')), 'deny')
    assert.deepEqual(legacySandboxPolicy(home), { type: 'readOnly', networkAccess: false })
    rmSync(other, { recursive: true, force: true })
    // 不继承 :root 可读的（受限读）暂不支持
    assert.throws(
      () => compile({ r: { filesystem: { ':minimal': 'read', [cwd]: 'write' } } }, 'r', cwd),
      /没有让 :root 可读/,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

function context(cwd: string, rules: FileSystemRules): RuntimeTurnContext {
  return {
    cwd,
    threadId: 't',
    turnId: 'u',
    sandboxMode: 'workspace-write',
    sandboxPolicy: legacySandboxPolicy(rules),
    fileSystem: rules,
  } as RuntimeTurnContext
}

test('PROFILE-004：文件类工具按同一份规则查读写，搜索范围里有禁读目录也拒绝', () => {
  const root = scratch('profile-tools')
  try {
    const own = join(root, 'ws/A')
    mkdirSync(own, { recursive: true })
    mkdirSync(join(root, 'ws/B'), { recursive: true })
    mkdirSync(join(root, 'home/A/.codex'), { recursive: true })
    writeFileSync(join(root, 'ws/B/secret'), 'b')
    symlinkSync(join(root, 'ws/B/secret'), join(own, 'link'))
    const rules = compile(
      {
        s: {
          extends: ':workspace',
          filesystem: {
            [join(root, 'ws')]: 'deny',
            [join(root, 'home')]: 'deny',
            [join(root, 'home/A/.codex')]: 'read',
          },
        },
      },
      's',
      own,
      [own],
    )
    const ctx = context(own, rules)
    const denied = (name: string, input: Record<string, unknown>) => deniedTool(ctx, name, input)
    assert.equal(denied('Read', { file_path: join(own, 'a.txt') }), null)
    assert.match(String(denied('Read', { file_path: join(root, 'ws/B/secret') })), /禁止读取/)
    assert.match(String(denied('Read', { file_path: '../B/secret' })), /禁止读取/)
    // 自己工作区里指向别人目录的链接：按真实路径算
    assert.match(String(denied('Read', { file_path: 'link' })), /禁止读取/)
    assert.equal(denied('Read', { file_path: join(root, 'home/A/.codex/config.toml') }), null)
    assert.match(String(denied('LS', { path: join(root, 'home') })), /禁止读取/)
    assert.equal(denied('Grep', { pattern: 'x' }), null)
    assert.match(String(denied('Grep', { pattern: 'x', path: root })), /搜索范围包含禁止读取/)
    assert.match(String(denied('Glob', { pattern: `${root}/ws/**/secret` })), /禁止读取/)
    assert.match(String(denied('Glob', { pattern: '**/*', path: '/' })), /搜索范围包含禁止读取/)
    assert.equal(denied('Write', { file_path: join(own, 'new.txt') }), null)
    assert.match(String(denied('Write', { file_path: 'link' })), /禁止读取|超出授权目录/)
    assert.match(
      String(denied('Edit', { file_path: join(root, 'home/A/.codex/config.toml') })),
      /超出授权目录/,
    )
    assert.match(String(denied('Write', { file_path: '/etc/litch-profile-test' })), /超出授权目录/)
    assert.equal(denied('Bash', { command: 'ls' }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 卷不分大小写时（macOS 默认）字面不同的路径是同一个目录
function caseInsensitive(dir: string): boolean {
  try {
    return realpathSync.native(dir.toUpperCase()) === dir
  } catch {
    return false
  }
}

test('PROFILE-007：大小写变体、不存在的禁读路径、Glob 的 ..、可写目录下的元数据目录', () => {
  const root = scratch('profile-edges')
  try {
    const own = join(root, 'ws/A')
    mkdirSync(join(own, 'Secret'), { recursive: true })
    mkdirSync(join(own, '.git/hooks'), { recursive: true })
    mkdirSync(join(own, 'open/.codex'), { recursive: true })
    writeFileSync(join(own, 'Secret/k.txt'), 'k')
    const rules = compile(
      {
        s: {
          extends: ':workspace',
          filesystem: {
            [join(own, 'Secret')]: 'deny',
            [join(own, 'future')]: 'deny',
            [join(own, 'open')]: 'write',
            [join(own, 'open/.codex')]: 'write',
          },
        },
      },
      's',
      own,
      [own],
    )
    const ctx = context(own, rules)
    const denied = (name: string, input: Record<string, unknown>) => deniedTool(ctx, name, input)
    if (caseInsensitive(own)) {
      assert.match(String(denied('Read', { file_path: join(own, 'secret/k.txt') })), /禁止读取/)
      assert.match(String(denied('LS', { path: join(own, 'SECRET') })), /禁止读取/)
      assert.match(String(denied('Write', { file_path: join(own, 'SECRET/new.txt') })), /禁止读取/)
      // 不存在的禁读路径换个大小写也拦
      assert.match(String(denied('Write', { file_path: join(own, 'FUTURE/x') })), /禁止读取/)
    }
    // 不存在的禁读路径：读、写、建在它下面都拦
    assert.match(String(denied('Read', { file_path: join(own, 'future') })), /禁止读取/)
    assert.match(String(denied('Write', { file_path: join(own, 'future/x.txt') })), /禁止读取/)
    // Glob 的 pattern 带 .. 就不算搜索范围了，直接拒绝
    assert.match(String(denied('Glob', { pattern: '../**/k.txt' })), /不能带 \.\./)
    assert.match(String(denied('Glob', { pattern: 'a/../../B/*' })), /不能带 \.\./)
    assert.equal(denied('Glob', { pattern: '**/*.txt', path: join(own, 'open') }), null)
    // 可写目录下的 .git、.agents、.codex、.aws 只读，不存在的也一样；档位明确给了 write 的照档位
    for (const path of [
      '.git/hooks/pre-commit',
      '.agents/skills/x.md',
      '.codex/config.toml',
      '.aws/config',
    ])
      assert.match(String(denied('Write', { file_path: join(own, path) })), /超出授权目录/, path)
    assert.equal(denied('Read', { file_path: join(own, '.git/HEAD') }), null)
    assert.equal(denied('Write', { file_path: join(own, 'open/.codex/config.toml') }), null)
    assert.match(
      String(denied('Write', { file_path: join(own, 'open/.git/config') })),
      /超出授权目录/,
    )
    assert.equal(denied('Write', { file_path: join(own, 'gitignore/.git-not') }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 典型的 SaaS 档位：整个用户数据根禁读，放回自己的工作区（可写）和自己 codex home 里的一小块（只读）
function saasLayout(root: string): { own: string; rules: FileSystemRules } {
  const own = join(root, 'ws/A')
  for (const dir of ['ws/A/private', 'ws/A/.git', 'ws/B', 'home/A/.codex', 'cfg'])
    mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(own, 'a.txt'), 'a')
  writeFileSync(join(root, 'ws/B/secret'), 'b')
  writeFileSync(join(root, 'cfg/key'), 'k')
  writeFileSync(join(root, 'home/A/.codex/config.toml'), 'c')
  writeFileSync(join(root, 'home/A/top'), 't')
  const rules = compile(
    {
      s: {
        extends: ':workspace',
        filesystem: {
          [join(root, 'ws')]: 'deny',
          [join(root, 'cfg')]: 'deny',
          [join(root, 'home')]: 'deny',
          [join(root, 'home/A/.codex')]: 'read',
          [join(own, 'private')]: 'deny',
          // 还不存在的禁读路径
          [join(own, 'future')]: 'deny',
        },
      },
    },
    's',
    own,
    [own],
  )
  return { own, rules }
}

const SANDBOX_CASES: Array<[string, (root: string) => string, boolean]> = [
  ['读自己的工作区', () => 'cat a.txt', true],
  ['读别人的工作区', (root) => `cat ${root}/ws/B/secret`, false],
  ['列用户数据根', (root) => `ls ${root}/ws`, false],
  ['读服务端配置', (root) => `cat ${root}/cfg/key`, false],
  ['读放回的只读子目录', (root) => `cat ${root}/home/A/.codex/config.toml`, true],
  ['读被禁目录里没放回的文件', (root) => `cat ${root}/home/A/top`, false],
  ['往只读子目录里写', (root) => `echo x > ${root}/home/A/.codex/w`, false],
  ['工作区里再禁的子目录', () => 'ls private', false],
  ['写自己的工作区', () => 'echo x > new.txt && cat new.txt', true],
  ['写用户数据根', (root) => `echo x > ${root}/ws/top`, false],
  ['大小写不同的禁读目录', () => 'ls PRIVATE', false],
  ['建出不存在的禁读路径', () => 'mkdir future', false],
  ['写不存在的禁读路径', () => 'echo x > future', false],
  ['改 .git', () => 'echo x > .git/config', false],
  ['建 .codex', () => 'mkdir .codex', false],
  ['建 .agents', () => 'mkdir -p .agents/skills', false],
  ['别的点目录照常写', () => 'mkdir -p .cache && echo x > .cache/y', true],
]

// 跑完沙箱，宿主上不留占位，也没被建出来
function assertNoLeftovers(own: string): void {
  for (const name of ['future', '.codex', '.agents'])
    assert.equal(existsSync(join(own, name)), false, `${name} 不该留在宿主上`)
}

test('PROFILE-005：macOS 的 sandbox-exec 按同一份规则禁读、挂回', {
  skip: process.platform !== 'darwin',
}, () => {
  const root = scratch('profile-seatbelt')
  try {
    const { own, rules } = saasLayout(root)
    for (const [name, command, allowed] of SANDBOX_CASES) {
      const [bin, ...args] = sandboxCommand(
        ['/bin/sh', '-c', command(root)],
        own,
        { sandboxPolicy: legacySandboxPolicy(rules) },
        own,
        [],
        rules,
      )
      const result = spawnSync(bin as string, args, { cwd: own, encoding: 'utf8' })
      assert.equal(result.status === 0, allowed, `${name}：${result.stderr}`)
    }
    assertNoLeftovers(own)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function bwrapUsable(): boolean {
  if (process.platform !== 'linux') return false
  return spawnSync('bwrap', ['--ro-bind', '/', '/', '--', '/bin/true']).status === 0
}

test('PROFILE-006：bwrap 用空 tmpfs 盖住禁读目录、建好挂载点再挂回，最后改成只读', () => {
  const root = scratch('profile-bwrap-args')
  try {
    const { own, rules } = saasLayout(root)
    // 工作区根还不存在时（sandboxPolicy 投影里也有它）照样能包，不去取它的真实路径
    const missing = compile({ s: { extends: ':workspace' } }, 's', own, [join(root, 'not-yet')])
    assert.ok(
      sandboxCommand(
        ['true'],
        own,
        { sandboxPolicy: legacySandboxPolicy(missing) },
        own,
        [],
        missing,
      ).length > 1,
    )
    const { args, placeholders } = bwrapFileSystemArgs(rules)
    const at = (...needle: string[]) =>
      args.findIndex((_, index) => needle.every((part, offset) => args[index + offset] === part))
    assert.deepEqual(args.slice(0, 7), ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'])
    const ws = join(root, 'ws')
    const home = join(root, 'home')
    // 有要挂回的给 111（只许穿过），没有的给 000
    assert.ok(at('--perms', '111', '--tmpfs', ws) >= 0)
    assert.ok(at('--perms', '000', '--tmpfs', join(root, 'cfg')) >= 0)
    assert.ok(at('--dir', join(home, 'A')) > at('--tmpfs', home))
    assert.ok(at('--dir', join(home, 'A/.codex')) > at('--dir', join(home, 'A')))
    assert.ok(at('--bind', own, own) > at('--tmpfs', ws))
    assert.ok(at('--ro-bind', join(home, 'A/.codex'), join(home, 'A/.codex')) > 0)
    assert.ok(at('--perms', '000', '--tmpfs', join(own, 'private')) > at('--bind', own, own))
    // 改只读在所有挂载之后
    const lastMount = Math.max(at('--bind', own, own), at('--tmpfs', join(own, 'private')))
    assert.ok(at('--remount-ro', ws) > lastMount)
    assert.ok(at('--remount-ro', home) > lastMount)
    // 已有的 .git 只读挂回；不存在的禁读路径放 /dev/null 占位，工作区根下不存在的元数据目录放只读空目录
    assert.ok(at('--ro-bind', join(own, '.git'), join(own, '.git')) > at('--bind', own, own))
    assert.ok(at('--ro-bind', '/dev/null', join(own, 'future')) > at('--bind', own, own))
    assert.ok(at('--perms', '555', '--tmpfs', join(own, '.codex'), '--remount-ro') > 0)
    assert.deepEqual(
      [...placeholders].sort(),
      ['.agents', '.aws', '.codex', 'future'].map((name) => join(own, name)).sort(),
    )
    if (!bwrapUsable()) return
    for (const [name, command, allowed] of SANDBOX_CASES) {
      const [bin, ...rest] = sandboxCommand(
        ['/bin/sh', '-c', command(root)],
        own,
        { sandboxPolicy: legacySandboxPolicy(rules) },
        own,
        [],
        rules,
      )
      const result = spawnSync(bin as string, rest, { cwd: own, encoding: 'utf8' })
      assert.equal(result.status === 0, allowed, `${name}：${result.stderr}`)
    }
    assertNoLeftovers(own)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
