// 页面栈。原生栈（react-native-screens）：切页的动画在原生那边做，不占 JS 线程。
// 每个页面自己画标题栏（src/ui/kit/Screen.tsx），所以这里一律关掉导航库的标题栏。
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { WebViewBench } from '../bench/WebViewBench'
import { DetailScreen } from '../detail/DetailScreen'
import { AddDeviceScreen } from '../screens/devices/AddDeviceScreen'
import { DeviceDetailScreen } from '../screens/devices/DeviceDetailScreen'
import { DevicesScreen } from '../screens/devices/DevicesScreen'
import { FilesScreen } from '../screens/files/FilesScreen'
import { NewSessionScreen } from '../screens/new-session/NewSessionScreen'
import { SessionsScreen } from '../screens/sessions/SessionsScreen'
import { SettingsScreen } from '../screens/settings/SettingsScreen'
import { DiffScreen } from '../screens/tools/DiffScreen'
import { TerminalScreen } from '../screens/tools/TerminalScreen'
import type { RootStackParamList } from './routes'

const Stack = createNativeStackNavigator<RootStackParamList>()

export function Navigator() {
  return (
    <Stack.Navigator
      initialRouteName="Devices"
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <Stack.Screen name="Devices" component={DevicesScreen} />
      <Stack.Screen name="AddDevice" component={AddDeviceScreen} />
      <Stack.Screen name="DeviceDetail" component={DeviceDetailScreen} />
      <Stack.Screen name="Sessions" component={SessionsScreen} />
      <Stack.Screen name="NewSession" component={NewSessionScreen} />
      <Stack.Screen name="Detail" component={DetailScreen} />
      <Stack.Screen name="Terminal" component={TerminalScreen} />
      <Stack.Screen name="Diff" component={DiffScreen} />
      <Stack.Screen name="Files" component={FilesScreen} />
      <Stack.Screen name="Settings" component={SettingsScreen} />
      <Stack.Screen name="Bench" component={WebViewBenchScreen} />
    </Stack.Navigator>
  )
}

function WebViewBenchScreen({ navigation }: { navigation: { goBack(): void } }) {
  return <WebViewBench onBack={() => navigation.goBack()} />
}
