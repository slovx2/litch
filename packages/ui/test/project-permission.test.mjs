// 两端运行真实权限钩子；只替换 React 调度和通道，覆盖没有目录和旧设备的退化路径。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from '../../../node_modules/esbuild/lib/main.js'

for (const platform of ['desktop', 'mobile']) {
  test(`${platform}：无目录也保存、重开和换 harness 共用；失败明确返回错误`, async () => {
    let states = []
    let cursor = 0
    const opened = []
    const records = new Map()
    let available = true
    let failure = null
    let calls = 0
    globalThis.__permissionHooks = {
      useState(initial) {
        const index = cursor++
        if (!(index in states)) states[index] = initial
        return [states[index], (value) => (states[index] = value)]
      },
    }
    const result = await build({
      entryPoints: [
        new URL(
          platform === 'desktop'
            ? '../src/composer/project-permission.ts'
            : '../../../apps/mobile/src/detail/composer/project-permission.ts',
          import.meta.url,
        ).pathname,
      ],
      bundle: true,
      write: false,
      format: 'esm',
      plugins: [
        {
          name: 'permission-hooks',
          setup(api) {
            const sources = {
              react: `export const useState=x=>globalThis.__permissionHooks.useState(x);
            export const useCallback=x=>x; export const useEffect=f=>f();
            export const useSyncExternalStore=(_,read)=>read();`,
              '@litch/core': `export const permissionLevel=x=>[':read-only',':workspace',':danger-full-access'].includes(x)?x:null;
            export const keys={projectPermission:(d,p)=>'permission:'+d+':'+p,projectPermissionError:(d,p)=>'error:'+d+':'+p};`,
              '../../ui/i18n': 'export const useT=()=>key=>key;',
              '../app/appearance.ts': 'export const useT=()=>key=>key;',
              '../app/errors.ts': 'export const reasonOf=x=>x.message;',
            }
            api.onResolve({ filter: /.*/ }, ({ path }) =>
              path in sources ? { path, namespace: 'fixture' } : undefined,
            )
            api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
              contents: sources[path],
            }))
          },
        },
      ],
    })
    try {
      const { useProjectPermission } = await import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
      )
      const services = {
        channel: {
          command: async (method, input) => {
            calls++
            assert.equal(method, 'projectPermission.set')
            if (!available) throw new Error('设备不支持项目权限，请升级设备服务')
            if (failure) throw new Error(failure)
            records.set(`permission:${input.deviceId}:${input.cwd}`, {
              cwd: input.cwd,
              permission: input.permission,
              confirmedPermissions: input.confirmed ? [input.permission] : [],
            })
          },
        },
        replica: {
          openProjectPermission: (d, p) => {
            opened.push([d, p])
            return () => {}
          },
          store: {
            subscribe: () => () => {},
            get: (key) =>
              key.startsWith('error:')
                ? undefined
                : {
                    available,
                    record: available
                      ? (records.get(key) ?? {
                          cwd: key,
                          permission: null,
                          confirmedPermissions: [],
                        })
                      : null,
                  },
          },
        },
      }
      const render = (cwd = null, device = 'remote') => {
        cursor = 0
        // biome-ignore lint/correctness/useHookAtTopLevel: 测试调度器逐次执行完整钩子。
        return useProjectPermission(services, device, cwd)
      }
      available = false
      assert.equal(await render('/project').save(':danger-full-access', true), false)
      assert.match(render('/project').error, /unavailable/)
      available = true
      states = []
      await assert.rejects(render().persist(':danger-full-access'), /confirmFirst/)
      assert.equal(calls, 0, '默认完全访问不能伪造确认')
      assert.equal(await render().save(':danger-full-access', true), true)
      assert.equal(calls, 1, '没有项目时必须发送保存请求，不能假报成功')
      assert.ok(opened.some(([d, p]) => d === 'remote' && p === ''))
      states = []
      assert.equal(
        render().permission,
        ':danger-full-access',
        '重开页面读取设备记忆，不依赖 harness',
      )
      assert.equal(render().confirmed(':danger-full-access'), true)
      assert.equal(render(null, 'other-device').permission, null)
      assert.equal(render('/other-project').permission, null)
      available = false
      assert.equal(await render('/project').save(':danger-full-access', true), false)
      assert.match(render('/project').error, /不支持|unavailable/)
      available = true
      failure = '写入失败'
      assert.equal(await render('/project').save(':workspace', false), false)
      assert.match(render('/project').error, /写入失败/)
      failure = null
      assert.equal(await render('/project').save(':read-only', false), true)
      assert.equal(render('/project').error, null, '可以重试保存')
    } finally {
      delete globalThis.__permissionHooks
    }
  })
}
