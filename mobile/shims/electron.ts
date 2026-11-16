import { EventEmitter } from 'events'
import { Buffer } from 'buffer'
import {nativeSync,nativeRequest} from '../bridge'
const handlers = new Map<string, (...args:any[])=>any>()
const events = new EventEmitter(); events.setMaxListeners(100)
export const ipcMain = {
  handle(channel:string,handler:(...args:any[])=>any){ if(handlers.has(channel))throw new Error(`Duplicate channel: ${channel}`);handlers.set(channel,handler) },
  removeHandler(channel:string){handlers.delete(channel)},
  on(channel:string,handler:(...args:any[])=>any){events.on(`send:${channel}`,handler);return this},
}
export const mobileSender = Object.assign(new EventEmitter(),{id:1,mainFrame:{url:globalThis.location?.href ?? 'https://appassets.androidplatform.net/index.html'},send:(channel:string,...args:any[])=>events.emit(channel,...args),isDestroyed:()=>false,isLoadingMainFrame:()=>false})
const sender = mobileSender
sender.setMaxListeners(100)
export const mobileWindow = Object.assign(new EventEmitter(),{id:1,webContents:sender,isDestroyed:()=>false,minimize:()=>nativeRequest('app.background'),maximize:()=>{},unmaximize:()=>{},isMaximized:()=>true,close:()=>{
  let prevented=false
  mobileWindow.emit('close',{preventDefault(){prevented=true}})
  if(!prevented)return nativeRequest('app.close').then(()=>{mobileWindow.emit('closed');sender.emit('destroyed')})
}})
const win = mobileWindow
export const BrowserWindow = {fromWebContents:()=>win,getAllWindows:()=>[win]}
type Environment = { filesDir: string; cacheDir: string; version: string }
let environment: Environment | undefined
const env = (): Environment => environment ??= nativeSync<Environment>('env')
export const app = Object.assign(new EventEmitter(),{isPackaged:true,getLocale:()=>navigator.language||'zh-CN',getVersion:()=>env().version,getPath:(name:string)=>{const value=env();return name==='temp'?value.cacheDir:name==='userData'?value.filesDir+'/webview-profile':value.filesDir},getAppPath:()=>env().filesDir,quit:()=>{app.emit('before-quit');win.close()}})
export const dialog = {showOpenDialog:(...args:any[])=>nativeRequest('dialog.open',args.at(-1)),showSaveDialog:(...args:any[])=>nativeRequest('dialog.save',args.at(-1)),showMessageBox:(...args:any[])=>nativeRequest('dialog.message',args.at(-1))}
export const shell = {openExternal:(url:string)=>nativeRequest('shell.open',url),openPath:(path:string)=>nativeRequest('shell.openPath',path)}
/** Android Keystore AES/GCM; secret material is device-bound and never falls back to plain text. */
export const safeStorage = {
  isEncryptionAvailable: () => { try { return nativeSync('secureStorage.available') === true } catch { return false } },
  getSelectedStorageBackend: () => safeStorage.isEncryptionAvailable() ? 'android_keystore' : 'unknown',
  encryptString: (value: string): Buffer => Buffer.from(nativeSync<string>('secureStorage.encrypt', value), 'base64'),
  decryptString: (value: Buffer): string => nativeSync<string>('secureStorage.decrypt', value.toString('base64')),
}
class NativeImage {
  constructor(private bytes:Buffer,private dimensions?:{width:number;height:number}){}
  isEmpty(){try{const size=this.getSize();return !size.width||!size.height}catch{return true}}
  getSize(): {width:number;height:number} {return this.dimensions??nativeSync('image.inspect',this.bytes.toString('base64'))}
  resize(size:{width:number;height:number}){return new NativeImage(this.bytes,size)}
  toPNG(){return this.convert('png',100)}
  toJPEG(quality:number){return this.convert('jpeg',quality)}
  private convert(format:string,quality:number){return Buffer.from(nativeSync('image.convert',this.bytes.toString('base64'),format,quality,this.dimensions?.width??null,this.dimensions?.height??null),'base64')}
}
export const nativeImage={createFromBuffer:(bytes:Buffer)=>new NativeImage(bytes)}
export function installRendererAPI(){
  const api={
    async invoke(channel:string,...args:unknown[]){const handler=handlers.get(channel);if(!handler)throw new Error(`Unknown request: ${channel}`);if(channel==='project:open'||channel==='project:create')await new Promise(resolve=>setTimeout(resolve,16));return await handler({sender,senderFrame:sender.mainFrame},...args)},
    on(channel:string,callback:(...args:any[])=>void){events.on(channel,callback);return()=>{events.removeListener(channel,callback)}},
    once(channel:string,callback:(...args:any[])=>void){events.once(channel,callback)},
    send(channel:string,...args:any[]){events.emit(`send:${channel}`,{sender},...args)},
    setZoomLevel:(_level:number)=>{},setZoomFactor:(_factor:number)=>{},getZoomLevel:()=>0,
  }
  Object.defineProperty(window,'aiNovelAPI',{value:api,writable:false,configurable:false})
  return {api,channels:()=>[...handlers.keys()]}
}
export {handlers as mobileHandlers}
