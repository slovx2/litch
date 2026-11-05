// 页面栈。原生栈（react-native-screens）：切页的动画在原生那边做，不占 JS 线程。
// 每个页面自己画标题栏（src/ui/kit/Screen.tsx），所以这里一律关掉导航库的标题栏。

import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { Dimensions, Platform } from 'react-native'
import { WebViewBench } from '../bench/WebViewBench'
import { AgentScreen } from '../detail/agents/AgentScreen'
import { BackgroundScreen } from '../screens/background/BackgroundScreen'
import { AddDeviceScreen } from '../screens/devices/AddDeviceScreen'
import { DeviceDetailScreen } from '../screens/devices/DeviceDetailScreen'
import { DevicesScreen } from '../screens/devices/DevicesScreen'
import { HarnessSettingsScreen } from '../screens/devices/hconfig/HarnessSettingsScreen'
import { PairDeviceScreen } from '../screens/devices/PairDeviceScreen'
import { FilesScreen } from '../screens/files/FilesScreen'
import { ManagerConsoleScreen } from '../screens/managers/ManagerConsoleScreen'
import { ManagersScreen } from '../screens/managers/ManagersScreen'
import { NewSessionScreen } from '../screens/new-session/NewSessionScreen'
import { ProposalStartScreen } from '../screens/proposals/ProposalStartScreen'
import { ProposalsScreen } from '../screens/proposals/ProposalsScreen'
import { SessionsScreen } from '../screens/sessions/SessionsScreen'
import { SettingsScreen } from '../screens/settings/SettingsScreen'
import { TailscaleScreen } from '../screens/settings/TailscaleScreen'
import { TaskDetailScreen } from '../screens/tasks/TaskDetailScreen'
import { TaskEditScreen } from '../screens/tasks/TaskEditScreen'
import { TasksScreen } from '../screens/tasks/TasksScreen'
import { DiffScreen } from '../screens/tools/DiffScreen'
import { TerminalScreen } from '../screens/tools/TerminalScreen'
import type { RootStackParamList } from './routes'
import { SessionScreen } from './SessionScreen'
import { tabletStack } from './TabletNavigator'

const nativeStack = createNativeStackNavigator<RootStackParamList>()
// 设备类别在启动时选定；分屏或键盘改变窗口尺寸不能换导航器、丢掉路由实例。
const screen = Dimensions.get('screen')
const tablet =
  Platform.OS === 'web' ||
  (Platform.OS === 'ios' ? Platform.isPad : Math.min(screen.width, screen.height) >= 600)
const Stack: typeof nativeStack = tablet ? tabletStack : nativeStack

export function Navigator() {
  return (
    <Stack.Navigator
      initialRouteName="Devices"
      // 手机继续锁竖屏；平板由系统窗口管理方向。
      screenOptions={{
        headerShown: false,
        animation: 'slide_from_right',
        orientation: tablet ? 'all' : 'portrait_up',
      }}
    >
      <Stack.Screen
        name="Managers"
        getId={() => (tablet ? 'managers' : undefined)}
        component={ManagersScreen}
      />
      <Stack.Screen
        name="ManagerConsole"
        getId={({ params }) =>
          tablet ? JSON.stringify([params.deviceId, params.managerId]) : undefined
        }
        component={ManagerConsoleScreen}
      />
      <Stack.Screen
        name="Devices"
        getId={() => (tablet ? 'devices' : undefined)}
        component={DevicesScreen}
      />
      <Stack.Screen name="AddDevice" component={AddDeviceScreen} />
      <Stack.Screen name="PairDevice" component={PairDeviceScreen} />
      <Stack.Screen name="DeviceDetail" component={DeviceDetailScreen} />
      <Stack.Screen name="HarnessSettings" component={HarnessSettingsScreen} />
      <Stack.Screen
        name="Sessions"
        getId={({ params }) => (tablet ? params.deviceId : undefined)}
        component={SessionsScreen}
      />
      <Stack.Screen name="NewSession" component={NewSessionScreen} />
      <Stack.Screen
        name="Detail"
        getId={({ params }) =>
          tablet ? JSON.stringify([params.deviceId, params.sessionId]) : undefined
        }
        component={SessionScreen}
      />
      <Stack.Screen name="Agent" component={AgentScreen} />
      <Stack.Screen name="Proposals" component={ProposalsScreen} />
      <Stack.Screen name="Background" component={BackgroundScreen} />
      <Stack.Screen name="ProposalStart" component={ProposalStartScreen} />
      <Stack.Screen name="Terminal" component={TerminalScreen} />
      <Stack.Screen name="Diff" component={DiffScreen} />
      <Stack.Screen name="Files" component={FilesScreen} />
      <Stack.Screen name="Tasks" component={TasksScreen} />
      <Stack.Screen name="TaskEdit" component={TaskEditScreen} />
      <Stack.Screen name="TaskDetail" component={TaskDetailScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="Tailscale" component={TailscaleScreen} />
      <Stack.Screen name="Bench" component={WebViewBenchScreen} />
    </Stack.Navigator>
  )
}

function WebViewBenchScreen({ navigation }: { navigation: { goBack(): void } }) {
  return <WebViewBench onBack={() => navigation.goBack()} />
}
