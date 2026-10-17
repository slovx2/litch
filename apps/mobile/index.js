import { registerRootComponent } from 'expo'

// 核心按 ES2023 写（Array.prototype.with、findLast 等），Hermes 支不支持在这里记一行
console.log(
  `[自检] with=${typeof [].with} findLast=${typeof [].findLast} toSpliced=${typeof [].toSpliced} hermes=${typeof HermesInternal}`,
)

import App from './src/App'

registerRootComponent(App)
