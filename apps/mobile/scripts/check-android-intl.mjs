// 用 Metro 的源映射检查实际装进 Android 包的自有代码，不限制只在桌面或 WebView 执行的模块。
import { readFileSync } from 'node:fs'
import { parse } from '@babel/parser'

const sourceMap = process.argv[2]
if (!sourceMap) throw new Error('用法：node check-android-intl.mjs <Android Metro source map>')

const ownSource =
  /^(?:\/?(?:src|modules)\/|(?:.*\/)?apps\/mobile\/(?:src|modules)\/|(?:.*\/)?packages\/(?:core|protocol|ui)\/src\/)/
const property = (node) =>
  node.computed
    ? node.property.type === 'StringLiteral'
      ? node.property.value
      : null
    : node.property.name
const member = (node) =>
  node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression'
const intl = (node) =>
  (node?.type === 'Identifier' && node.name === 'Intl') ||
  (member(node) &&
    node.object.type === 'Identifier' &&
    node.object.name === 'globalThis' &&
    property(node) === 'Intl')
const intlMember = (node) => member(node) && intl(node.object)
const typeTest = (test, name) =>
  test?.type === 'BinaryExpression' &&
  test.operator === '===' &&
  test.left.type === 'UnaryExpression' &&
  test.left.operator === 'typeof' &&
  intlMember(test.left.argument) &&
  property(test.left.argument) === name &&
  test.right.type === 'StringLiteral' &&
  test.right.value === 'function'

// 只放行 RN Hermes 上已经验过的格式化器；其他构造器需要在同一表达式先判能力。
const basicFormatters = new Set(['DateTimeFormat', 'NumberFormat'])
const basicNumberOptions = new Set([
  'maximumFractionDigits',
  'minimumFractionDigits',
  'useGrouping',
])
const localeStrings = new Set([
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
])
function visit(node, parent, grandparent, report) {
  if (!node?.type) return
  if (
    intl(node) &&
    ((parent?.type === 'VariableDeclarator' && parent.init === node) ||
      (parent?.type === 'AssignmentExpression' && parent.right === node))
  ) {
    report(node, '不要给 Intl 起别名或解构，构造器应直接显示其能力检查')
  }
  if (intlMember(node)) {
    const name = property(node)
    const typeofCheck = parent?.type === 'UnaryExpression' && parent.operator === 'typeof'
    const directCall =
      (parent?.type === 'NewExpression' || parent?.type === 'CallExpression') &&
      parent.callee === node
    const guarded =
      name &&
      directCall &&
      grandparent?.type === 'ConditionalExpression' &&
      grandparent.consequent === parent &&
      typeTest(grandparent.test, name)
    if (!typeofCheck && !guarded && !basicFormatters.has(name)) {
      report(node, `Intl.${name ?? '[动态属性]'} 缺少运行时能力检查`)
    }
    if (!typeofCheck && name === 'NumberFormat') {
      const options = directCall && parent.arguments[1]
      if (
        !directCall ||
        (options &&
          (options.type !== 'ObjectExpression' ||
            options.properties.some(
              (entry) =>
                entry.type !== 'ObjectProperty' ||
                entry.computed ||
                !basicNumberOptions.has(entry.key.name ?? entry.key.value),
            )))
      ) {
        report(node, 'NumberFormat 只允许已核验的基础数字选项')
      }
    }
  }
  if (
    (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
    node.arguments.length &&
    member(node.callee) &&
    localeStrings.has(property(node.callee))
  ) {
    report(node, '带参数的 toLocale* 请改用已核验的格式化器')
  }
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) {
      for (const entry of child) visit(entry, node, parent, report)
    } else visit(child, node, parent, report)
  }
}

const map = JSON.parse(readFileSync(sourceMap, 'utf8'))
const sources = (entry) =>
  entry.sections
    ? entry.sections.flatMap((section) => sources(section.map))
    : entry.sources.map((path, index) => [
        path.replaceAll('\\', '/'),
        entry.sourcesContent?.[index],
      ])
const checked = sources(map).filter(
  ([path]) =>
    ownSource.test(path) && !path.includes('/node_modules/') && /\.[cm]?[jt]sx?$/.test(path),
)
if (!checked.some(([path]) => /(?:^|\/)src\/App\.tsx$/.test(path)))
  throw new Error('源映射中没有手机入口，无法检查 Android Intl 用法')
let bad = 0
for (const [path, content] of checked) {
  if (typeof content !== 'string') throw new Error(`源映射未包含 ${path} 的源代码`)
  if (!/\bIntl\b|\btoLocale(?:String|DateString|TimeString|LowerCase|UpperCase)\b/.test(content))
    continue
  const ast = parse(content, {
    sourceType: 'unambiguous',
    plugins: path.endsWith('x') ? ['typescript', 'jsx'] : ['typescript'],
  })
  visit(ast, null, null, (node, message) => {
    bad++
    console.error(`${path}:${node.loc.start.line} ${message}`)
  })
}
if (bad) process.exitCode = 1
else console.log(`Android Intl 检查通过：${checked.length} 个自有模块`)
