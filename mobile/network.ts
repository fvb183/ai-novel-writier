import { Buffer } from 'buffer'
import {nativeId,nativeStream,nativeSync} from './bridge'
import {readJsonFile,GLOBAL_CONFIG_PATH,DEFAULT_GLOBAL_CONFIG} from '../electron/utils/config-utils'
import { proxyServerUrl } from '../src/shared/proxy-config'
import { nativeReadTimeoutMs } from '../electron/services/google-drive-request-budget'
export const NATIVE_HTTP_IDLE_TIMEOUT_MS = 180_000
/** Fetch with a native TLS connection: API credentials never go through a proxy service. */
export function installNativeFetch() {
  const browserFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const resolved = new URL(url, location.href)
    if (resolved.origin === location.origin || resolved.protocol === 'data:' || resolved.protocol === 'blob:') return browserFetch(input, init)
    if (!/^https?:$/.test(resolved.protocol)) throw new TypeError('Only HTTP and HTTPS API endpoints are supported')
    const req = new Request(input, init)
    // Request clones its signal, so read the Drive budget from its original signal.
    const timeoutMs = nativeReadTimeoutMs(init.signal ?? (input instanceof Request ? input.signal : undefined)) ?? NATIVE_HTTP_IDLE_TIMEOUT_MS
    if (req.signal.aborted) throw req.signal.reason ?? new DOMException('Aborted','AbortError')
    const bytes = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer())
    const proxy = proxyServerUrl(readJsonFile(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG).proxy)
    const headers: Record<string,string> = {}; req.headers.forEach((v,k) => {headers[k]=v})
    return new Promise((resolve,reject) => {
      const id = nativeId()
      let controller: ReadableStreamDefaultController<Uint8Array>
      let headersReceived = false, ended = false
      let dispose = () => {}
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const body = new ReadableStream<Uint8Array>({start(c){controller=c},cancel(){cancel()}})
      const cleanup = () => { clearTimeout(idleTimer); dispose(); req.signal.removeEventListener('abort', abort) }
      const cancelNative = () => { try { nativeSync('http.cancel',id) } catch {} }
      const cancel = () => { if (ended) return; ended=true; cleanup(); cancelNative() }
      const fail = (error: Error) => {
        if(ended) return
        ended = true
        if(headersReceived) controller.error(error); else reject(error)
        cleanup()
      }
      // This is an inactivity deadline: active model streams are never cut off
      // solely because their total generation time is long.
      const touch = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => { fail(Object.assign(new TypeError('Network request timed out'), { code: 'NETWORK_TIMEOUT' })); cancelNative() }, timeoutMs)
      }
      const abort = () => { const error = req.signal.reason ?? new DOMException('Aborted','AbortError'); fail(error); cancelNative() }
      req.signal.addEventListener('abort',abort,{once:true})
      touch()
      try { dispose = nativeStream(id,'http.request',[resolved.href,{method:req.method,headers,body:bytes?Buffer.from(bytes).toString('base64'):null,redirect:req.redirect,proxy,timeoutMs}],(event,data) => {
        if(ended)return
        touch()
        try { if(event==='headers') {
          if (headersReceived) throw new TypeError('Duplicate native response headers')
          const response=new Response([101,204,205,304].includes(data.status)||req.method==='HEAD'?null:body,{status:data.status,statusText:data.statusText||'',headers:data.headers})
          Object.defineProperty(response,'url',{value:data.url||resolved.href})
          headersReceived=true
          resolve(response)
        } else if(event==='data') controller.enqueue(new Uint8Array(Buffer.from(data,'base64')))
        else if(event==='end') {if(!headersReceived)throw new TypeError('Native response ended before headers');ended=true;controller.close();cleanup()}
        else if(event==='error') fail(Object.assign(new TypeError(data?.message||'Network request failed'), { code: data?.code === 'NETWORK_TIMEOUT' ? 'NETWORK_TIMEOUT' : 'NETWORK_ERROR' }))
        } catch (error) { fail(error instanceof Error ? error : new TypeError('Invalid native response')); cancelNative() }
      }); if (ended) dispose() }
      catch (error) { fail(error instanceof Error ? error : new TypeError('Native request failed')); cancelNative() }
      if(req.signal.aborted)abort()
    })
  }
}
