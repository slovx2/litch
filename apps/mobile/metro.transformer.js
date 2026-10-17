// 核心和协议的源码是 .mts。babel-preset-expo 只认 .ts、.tsx，而且 RN 的代码生成插件会把核心导出的
// `Commands` 类型误当成原生组件的保留名。所以分两步：先只去掉类型，再把纯 JS 交给 Expo 原来的转换器
const babel = require('@babel/core')

const upstream = require(process.env.LITCH_UPSTREAM_TRANSFORMER)

module.exports = {
  ...upstream,
  transform(args) {
    if (!args.filename.endsWith('.mts')) return upstream.transform(args)
    const stripped = babel.transformSync(args.src, {
      filename: args.filename.replace(/\.mts$/, '.ts'),
      babelrc: false,
      configFile: false,
      sourceType: 'module',
      presets: [require.resolve('@babel/preset-typescript')],
    })
    return upstream.transform({ ...args, src: stripped.code, filename: args.filename.replace(/\.mts$/, '.js') })
  },
}
