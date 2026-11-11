import { mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
export async function buildProcessMobileFixture() {
  const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
  const req = createRequire(root + '/packages/ui/package.json')
  const mobileReq = createRequire(root + '/apps/mobile/package.json')
  const output = mkdtempSync(join(tmpdir(), 'nebula-process-mobile-'))
  const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{View,Text}from'react-native';import{StepCell,GroupCell}from'${root}/apps/mobile/src/detail/steps.tsx';
const command='cd /srv/nebula/workspace && npm run verify -- --project nebula-archive --report detailed-results.json';
function Fixture(){const[lang,setLang]=useState('zh-CN');const[open,setOpen]=useState(false);const[output,setOutput]=useState('');window.__mobileLang=lang;window.__toggle=()=>setOpen(!open);window.__mobileCommand={lang:value=>{setLang(value);setOutput('')},output:()=>setOutput('Streaming nebula output\\n')};return <View style={{width:320,margin:24,backgroundColor:'#17212b'}}><Text style={{color:'#ddd',padding:16}}>星云 · 手机过程</Text><GroupCell row={{key:'group',turnId:'turn',ids:'c',count:1,running:true,thinking:false,current:command,since:1,ended:false,expanded:false,working:false,turnStartedAt:1}}/>{['running','done','failed','declined'].map((state,i)=><StepCell key={state} row={{key:state,turnId:'turn',state,item:{id:state,kind:'command',command,startedAt:1,elided:null},expanded:open,exitCode:state==='failed'?7:0,durationMs:state==='running'||state==='declined'?null:104000,output:state==='declined'?'':state==='running'?output:'Nebula verification output\\nCheck finished.\\n',tail:''}}/>)}</View>};createRoot(document.getElementById('root')).render(<Fixture/>);`
  const stubs = {
    codegen: `export default ()=>()=>null;`,
    cells: `export const styles={grow:{flex:1,minWidth:0}};export const useTicking=()=>104000;export const useLasting=()=>false;`,
    context: `export const useTranscript=()=>({openLink:()=>{}});export const useToggleInPlace=()=>()=>window.__toggle();export const useBackgroundView=()=>null;`,
    links: `export const isWebUrl=()=>false;export const fileHref=()=>'';`,
    keep: `export const keepPlace=()=>{};export const rowBelow=()=>null;`,
    core: `export const taskOfItem=()=>null;export const stepKindOf=()=>null;export const diffLines=()=>[];export const knownFileRef=()=>null;`,
    theme: `export const useTheme=()=>({c:{ink:'#ddd',ink2:'#b9b9b9',ink3:'#888',err:'#c66',wait:'#d9bd5c',accent:'#d9bd5c',line1:'#33404a',line2:'#33404a',sunken:'#101821'},skin:'human',hit:40,radius:{l:8},font:{mono:'monospace',ui:'sans-serif',size:{body:14,meta:12}}});`,
    i18n: `import{translator}from'${root}/packages/ui/src/i18n/index.ts';export const useT=()=>{const t=translator(window.__mobileLang||'zh-CN');return Object.assign((key,args)=>key==='detail.activity'?(window.__mobileLang==='en'?'Activity':'过程'):key==='detail.group.running'?(window.__mobileLang==='en'?'Running: ':'正在运行：')+args.label:key==='detail.step.noOutput'?(window.__mobileLang==='en'?'No output':'无输出'):key==='detail.step.failed'?(window.__mobileLang==='en'?'Failed':'失败'):key==='detail.step.declined'?(window.__mobileLang==='en'?'Declined':'已拒绝'):t(key,args),{text:x=>typeof x==='string'?x:t.text(x),lang:t.lang})};`,
    images: `export const ToolImages=()=>null;`,
    flash: `export const useFlashListContext=()=>null;`,
    breath: `import{Animated}from'react-native';const value=new Animated.Value(1);export const useBreath=()=>value;`,
  }
  await build({
    stdin: { contents: source, loader: 'tsx', resolveDir: root },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: output + '/fixture.js',
    jsx: 'automatic',
    define: { __DEV__: 'false', 'process.env.NODE_ENV': '"production"' },
    mainFields: ['browser', 'module', 'main'],
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
    conditions: ['browser'],
    plugins: [
      {
        name: 'fixture',
        setup(b) {
          b.onResolve({ filter: /^react(?:\/.*)?$|^react-dom(?:\/.*)?$/ }, (a) => ({
            path: req.resolve(a.path),
          }))
          b.onResolve(
            { filter: /react-native\/Libraries\/Utilities\/codegenNativeComponent/ },
            () => ({ path: 'codegen', namespace: 'stub' }),
          )
          b.onResolve({ filter: /^react-native$/ }, () => ({
            path: mobileReq.resolve('react-native-web'),
          }))
          b.onResolve({ filter: /^react-native-svg$/ }, () => ({
            path: root + '/apps/mobile/node_modules/react-native-svg/src/ReactNativeSVG.web.ts',
          }))
          b.onResolve({ filter: /.*/ }, (a) => {
            let key
            if (a.path === '@litch/core') key = 'core'
            if (a.path === '@shopify/flash-list') key = 'flash'
            if (a.path === './cells') key = 'cells'
            if (a.path === './context') key = 'context'
            if (a.path === './keep-place') key = 'keep'
            if (a.path === './links') key = 'links'
            if (a.path.endsWith('/theme') && a.importer.includes('/apps/mobile/')) key = 'theme'
            if (a.path === '../ui/i18n') key = 'i18n'
            if (a.path === './media/ToolImages') key = 'images'
            if (a.path === './breath') key = 'breath'
            if (key) return { path: key, namespace: 'stub' }
          })
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
            contents: stubs[a.path],
            loader: 'js',
            resolveDir: root,
          }))
        },
      },
    ],
  })
  writeFileSync(
    output + '/index.html',
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><link rel="icon" href="data:,"></head><body style="margin:0;background:#17212b"><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>',
  )
  return output
}
