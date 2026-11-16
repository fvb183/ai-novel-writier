import {registerIPCHandlers} from '../electron/ipc-handlers'
import {registerMCPHandlers} from '../electron/mcp/mcp-ipc-bridge'
import {registerUpdateController} from '../electron/controllers/update-controller'
import {startUpdateRuntime} from '../electron/services/update-startup'
import {GlobalConfigUpdatePreferencesStore} from '../electron/services/update-preferences-store'
import {app,ipcMain,installRendererAPI,mobileHandlers,mobileSender,mobileWindow} from './shims/electron'
import {installNativeFetch} from './network'
import {nativeRequest} from './bridge'
import {resolveGlobalDataRoots} from '../electron/services/app-data-locator'
import {runGlobalDataMigration,activateGlobalData} from '../electron/services/global-data-migration'
import {registerStartupController} from '../electron/controllers/startup-controller'
import {ensureVelaHome} from '../electron/utils/config-utils'
import {installWindowCloseGuard} from '../electron/controllers/window-controller'
export function startMobileBackend(){
  installNativeFetch()
  // Android owns one Activity/bridge instance. The native host locks its files
  // directory before this migration, including across Activity recreation.
  const migrated=runGlobalDataMigration({...resolveGlobalDataRoots(app.getPath('userData'),()=>app.getPath('appData')),exclusiveAccess:true})
  const {api}=installRendererAPI()
  registerStartupController({
    ipc:ipcMain,getTrustedSender:()=>mobileSender,rendererUrl:mobileSender.mainFrame.url,
    getGlobalGeneration:()=>migrated.state==='ready'?migrated.globalGeneration:null,
    getBlockedCode:()=>migrated.state==='ready'?undefined:migrated.code==='GLOBAL_MODEL_CREDENTIALS_DIFFER'?migrated.code:'GLOBAL_DATA_BLOCKED',
    getMigrationNotice:()=>migrated.state==='ready'?{legacySourceIgnored:migrated.legacySourceIgnored,preservedUnknownCount:migrated.preservedUnknownCount}:undefined,
  })
  if(migrated.state!=='ready')return api
  activateGlobalData(migrated)
  ensureVelaHome()
  registerIPCHandlers()
  installWindowCloseGuard(mobileWindow as unknown as Parameters<typeof installWindowCloseGuard>[0])
  registerMCPHandlers()
  ipcMain.removeHandler('mcp:connect')
  ipcMain.handle('mcp:connect',()=>({success:false,error:'安卓端不能运行电脑上的 MCP 命令（node、npx、python 等）。原项目的 SSE 连接也尚未实现。请在桌面版使用这些外部工具。'}))
  startUpdateRuntime({updateRuntimeEnabled:false,currentVersion:app.getVersion(),createBackend:()=>{throw new Error('Android updates use APK installation')},createPreferences:()=>new GlobalConfigUpdatePreferencesStore(),registerController:service=>registerUpdateController(service,{ipc:ipcMain,publish:state=>mobileSender.send('update:state',state)}),reportFailure:console.warn})
  // Use the same one-use grants, archive projection and new-project identity as
  // desktop. The old raw ZIP endpoints deliberately are no longer registered.
  // The system Back action first lets the mobile shell close its active overlay.
  ;(globalThis as any).__androidBack=()=>{
    const modal=document.querySelector('[role="dialog"]:not(.settings-overlay)')
    if(modal){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return}
    const event=new CustomEvent('android-back',{cancelable:true});window.dispatchEvent(event)
    if(event.defaultPrevented)return
    const dialog=document.querySelector('[role="dialog"]')
    if(dialog){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return}
    nativeRequest('app.background').catch(console.warn)
  }
  console.info(`[Android] ${mobileHandlers.size} backend channels ready`)
  return api
}
