import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

function load(context = null) {
  const module = { exports: {} }
  const element = (type, props) => ({ type, props })
  runInNewContext(
    transformSync(
      readFileSync(new URL('../src/manager/CardActions.tsx', import.meta.url), 'utf8'),
      { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
    ).code,
    {
      module,
      require(name) {
        if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
        if (name === 'react')
          return {
            createContext: () => ({ Provider: 'scope' }),
            useContext: () => context,
            useState: () => [null, () => {}],
          }
        if (name === 'react-dom')
          return { createPortal: (children, target) => ({ children, target }) }
        throw Error(name)
      },
    },
  )
  return module.exports
}

test('每张卡只生成一个卡尾；内嵌旧帖子沿用外层作用域', () => {
  const own = load().CardActionScope({ children: (footer) => footer })
  assert.equal(own.props.children.type, 'footer')
  assert.equal(own.props.children.props.className, 'mg-card-actions')
  assert.equal(load({ target: {} }).CardActionScope({ children: (footer) => footer }), null)
  assert.equal(
    load().CardActionScope({ active: false, children: (footer) => footer }).props.children,
    null,
  )
})

test('按钮只在同一卡片卡尾渲染一次；非看板场景保留原位置', () => {
  const children = { button: '回复' }
  const target = { footer: true }
  assert.equal(load().CardActions({ children }), children)
  assert.equal(load({ target: null }).CardActions({ children }), null)
  const portal = load({ target }).CardActions({ children })
  assert.equal(portal.children, children)
  assert.equal(portal.target, target)
})
