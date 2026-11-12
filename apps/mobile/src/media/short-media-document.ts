import {
  SHORT_MEDIA_BYTES,
  SHORT_MEDIA_PIXELS,
  SHORT_MEDIA_SECONDS,
  type ShortMediaType,
} from '@litch/core'

/** WebView 与网页预览共用离线播放器，不含导航、网络或 seek 接口。 */
export function shortMediaDocument(data: string, type: ShortMediaType, background: string): string {
  if (
    data.length > Math.ceil(SHORT_MEDIA_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error('Invalid media data')
  const config = JSON.stringify({
    data,
    type,
    background,
    seconds: SHORT_MEDIA_SECONDS,
    pixels: SHORT_MEDIA_PIXELS,
  }).replaceAll('<', '\\u003c')
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src blob:; connect-src 'none'; frame-src 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}video,audio{width:100%;height:100%;object-fit:contain}</style></head><body><script>
  const config=${config};document.body.style.backgroundColor=config.background;
  const media=document.createElement(config.type.kind);media.preload='metadata';media.playsInline=true;media.controls=false;media.disableRemotePlayback=true;
  const send=value=>{const message=JSON.stringify({litchShortMedia:true,...value});if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(message);else parent.postMessage(message,'*')};
  let valid=false;let timer=setTimeout(()=>send({kind:'failed',reason:'timeout'}),15000);
  media.addEventListener('loadedmetadata',()=>{clearTimeout(timer);if(!Number.isFinite(media.duration)||media.duration<=0)return send({kind:'failed',reason:'mediaInvalid'});if(media.duration>config.seconds)return send({kind:'failed',reason:'mediaDuration'});if(media.videoWidth>16384||media.videoHeight>16384||media.videoWidth*media.videoHeight>config.pixels)return send({kind:'failed',reason:'mediaSize'});valid=true;send({kind:'ready'})});
  media.addEventListener('play',()=>send({kind:'playing',value:true}));media.addEventListener('pause',()=>send({kind:'playing',value:false}));media.addEventListener('ended',()=>send({kind:'playing',value:false}));media.addEventListener('error',()=>{clearTimeout(timer);send({kind:'failed',reason:'mediaInvalid'})});
  window.__litchMedia=action=>{if(action==='pause')media.pause();else if(action==='play'&&valid)media.play().catch(()=>send({kind:'failed',reason:'mediaInvalid'}))};
  window.addEventListener('message',event=>{if(event.source===parent&&event.data?.litchShortMedia===true)window.__litchMedia(event.data.action)});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)media.pause()});
  const raw=atob(config.data),array=new Uint8Array(raw.length);for(let n=0;n<raw.length;n++)array[n]=raw.charCodeAt(n);const url=URL.createObjectURL(new Blob([array],{type:config.type.mime}));media.src=url;window.addEventListener('pagehide',()=>{media.pause();URL.revokeObjectURL(url)});document.body.append(media);
  </script></body></html>`
}

export type ShortMediaEvent =
  | { kind: 'ready' }
  | { kind: 'playing'; value: boolean }
  | { kind: 'failed'; reason: 'mediaInvalid' | 'mediaDuration' | 'mediaSize' | 'timeout' }
export function shortMediaEvent(raw: string): ShortMediaEvent | null {
  try {
    const value = JSON.parse(raw)
    if (value.litchShortMedia !== true) return null
    if (value.kind === 'ready') return { kind: 'ready' }
    if (value.kind === 'playing' && typeof value.value === 'boolean')
      return { kind: 'playing', value: value.value }
    if (
      value.kind === 'failed' &&
      ['mediaInvalid', 'mediaDuration', 'mediaSize', 'timeout'].includes(value.reason)
    )
      return { kind: 'failed', reason: value.reason }
  } catch {
    /* 不接受播放器以外的消息。 */
  }
  return null
}
