import './globals'
import {startMobileBackend} from './backend'
async function boot(){
  document.documentElement.dataset.platform = 'android'
  startMobileBackend()
  await import('../src/main')
}
boot().catch(error=>{
  console.error('[Android startup]',error)
  const root=document.getElementById('root')!;root.replaceChildren()
  const title=document.createElement('h2');title.textContent='启动失败 / Startup failed'
  const detail=document.createElement('pre');detail.style.whiteSpace='pre-wrap';detail.textContent=String(error)
  const retry=document.createElement('button');retry.textContent='重新启动';retry.onclick=()=>location.reload()
  root.append(title,detail,retry)
})
