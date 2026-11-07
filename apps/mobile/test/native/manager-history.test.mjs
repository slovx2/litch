// 使用项目锁定的真实 StackRouter；需先安装手机依赖，单独运行本文件。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  StackActions,
  StackRouter,
} from '../../node_modules/@react-navigation/routers/lib/module/StackRouter.js'

for (const tablet of [false, true])
  for (const tab of ['console', 'overview', 'lines']) {
    test(`${tablet ? '平板' : '手机'} ${tab} 会话链接入栈，返回保留经理路由实例和原参数`, () => {
      const router = StackRouter({ initialRouteName: 'Devices' })
      const options = {
        routeNames: ['Devices', 'Detail', 'ManagerConsole'],
        routeParamList: {},
        routeGetIdList: tablet
          ? {
              Detail: ({ params }) => `${params.deviceId}:${params.sessionId}`,
              ManagerConsole: ({ params }) => `${params.deviceId}:${params.managerId}`,
            }
          : {},
      }
      let state = router.getInitialState(options)
      // 来源会话曾打开过；平板即便去重它，也不能挪掉当前经理页面。
      const target = { deviceId: 'local', sessionId: 'line' }
      state = router.getStateForAction(state, StackActions.push('Detail', target), options)
      const params = { deviceId: 'local', managerId: 'm1', tab }
      state = router.getStateForAction(state, StackActions.push('ManagerConsole', params), options)
      const board = state.routes[state.index]
      state = router.getStateForAction(state, StackActions.push('Detail', target), options)
      assert.equal(state.routes[state.index].name, 'Detail')
      state = router.getStateForAction(state, { type: 'GO_BACK' }, options)
      assert.equal(state.routes[state.index].key, board.key)
      assert.deepEqual(state.routes[state.index].params, params)
    })
  }
