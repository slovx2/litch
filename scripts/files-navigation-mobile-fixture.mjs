import { createRequire } from 'node:module'
import { join } from 'node:path'

/** 原生桥和导航用替身；文件屏、树、文本页、选择器、控件和主题都挂正式实现。 */
export function mobileFilesPlugin(root) {
  const req = createRequire(join(root, 'packages/ui/package.json'))
  const mobile = createRequire(join(root, 'apps/mobile/package.json'))
  const stubs = {
    services: `import{useSyncExternalStore}from'react';export const useChannel=()=>window.__filesNav.channel;export const useReplica=()=>window.__filesNav.replica;export const useKey=key=>useSyncExternalStore(fn=>window.__filesNav.replica.store.subscribe(key,fn),()=>window.__filesNav.replica.store.get(key));`,
    i18n: `import{translator}from'${root}/packages/ui/src/i18n/index.ts';const t=translator('zh-CN');export const useT=()=>t;`,
    navigation: `export const useIsFocused=()=>true;export const useNavigation=()=>window.__filesNav.navigation;`,
    insets: `export const useSafeAreaInsets=()=>({top:0,bottom:0,left:0,right:0});`,
    pane: `export const usePane=()=>null;`,
    keyboard: `export const KeyboardDismissBar=()=>null;`,
    overlays: `import React from'react';import{View,ScrollView}from'react-native';export const Dialog=({visible,children})=>visible?<View style={{position:'absolute',inset:8,zIndex:100,backgroundColor:'white',padding:16}}><ScrollView>{children}</ScrollView></View>:null;`,
    localization: `export const getLocales=()=>[{languageCode:'zh',languageTag:'zh-CN'}];`,
    clipboard: `export const setStringAsync=async()=>{};`,
    webview: `export const WebView=()=>null;`,
    codegen: `export default()=>()=>null;`,
  }
  return {
    name: 'files-navigation-mobile',
    setup(b) {
      b.onResolve({ filter: /^react(?:\/.*)?$|^react-dom(?:\/.*)?$/ }, (a) => ({
        path: req.resolve(a.path),
      }))
      b.onResolve({ filter: /^react-native$/ }, () => ({
        path: mobile.resolve('react-native-web'),
      }))
      b.onResolve({ filter: /^react-native-svg$/ }, () => ({
        path: join(root, 'apps/mobile/node_modules/react-native-svg/src/ReactNativeSVG.web.ts'),
      }))
      b.onResolve({ filter: /codegenNativeComponent/ }, () => ({
        path: 'codegen',
        namespace: 'files-stub',
      }))
      b.onResolve({ filter: /.*/ }, (a) => {
        let key
        if (a.path === '@react-navigation/native') key = 'navigation'
        if (a.path === 'react-native-safe-area-context') key = 'insets'
        if (a.path === 'react-native-webview') key = 'webview'
        if (a.path === 'expo-localization') key = 'localization'
        if (a.path === 'expo-clipboard') key = 'clipboard'
        if (a.importer.includes('/apps/mobile/')) {
          if (a.path.endsWith('/shell/services')) key = 'services'

          if (a.path.endsWith('/nav/pane')) key = 'pane'
          if (a.path === './KeyboardForm') key = 'keyboard'
          if (a.path.endsWith('/kit/overlays')) key = 'overlays'
        }
        if (key) return { path: key, namespace: 'files-stub' }
      })
      b.onLoad({ filter: /.*/, namespace: 'files-stub' }, (a) => ({
        contents: stubs[a.path],
        loader: 'jsx',
        resolveDir: root,
      }))
    },
  }
}
