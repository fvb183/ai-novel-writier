import {act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {page} from 'vitest/browser'
import StageSettings from '../StageSettings'
import type {ModelProfile} from '../../../../shared/ipc-channels'
import {SETTINGS_PAGES} from '../settings-pages'
import {useLayoutStore} from '../../../../stores/layout-store'
import {useProjectStore} from '../../../../stores/project-store'
import {useLLMStore} from '../../../../stores/llm-store'
import {useLocaleStore} from '../../../../stores/locale-store'
import '../../../../mobile/mobile.css'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
const models:ModelProfile[]=[{id:'text',name:'合成写作模型',provider:'openai',protocol:'openai',modelName:'synthetic-text',baseUrl:'https://invalid.example/v1',apiKey:'synthetic',temperature:0.7,maxTokens:4096,purposes:['generation'] as ('generation'|'embedding')[]}]
let root:Root,host:HTMLDivElement
const saved={layout:useLayoutStore.getState(),project:useProjectStore.getState(),llm:useLLMStore.getState(),locale:useLocaleStore.getState()}
beforeEach(()=>{
  document.documentElement.dataset.platform='android'
  Object.defineProperty(window,'aiNovelAPI',{configurable:true,value:{invoke:vi.fn(async(channel:string)=>{
    if(channel==='config:get')return{theme:'light',locale:'zh-CN'}
    if(channel==='drive:auth-status')return{success:true,auth:{platform:'android',configured:true,available:true,authorized:true,persistence:'google-play-services'}}
    if(channel==='llm:list-models')return models
    if(channel==='skills:list')return[]
    return{success:true}
  }),on:()=>()=>{}}})
  useLayoutStore.setState({settingsOpen:true,settingsSection:'stage-models'});useProjectStore.setState({currentProject:null})
  useLocaleStore.setState({locale:'zh-CN'});useLLMStore.setState({loaded:true,models,defaultModelId:'text',defaultEmbeddingModelId:null,stageModelIds:{}})
  host=document.createElement('div');host.className='paper-ink stage-shell';host.style.cssText='display:flex;width:100vw;height:100vh;min-width:0;overflow:hidden';document.body.style.margin='0';document.body.append(host);root=createRoot(host)
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete document.documentElement.dataset.platform;useLayoutStore.setState(saved.layout,true);useProjectStore.setState(saved.project,true);useLLMStore.setState(saved.llm,true);useLocaleStore.setState(saved.locale,true);Reflect.deleteProperty(window,'aiNovelAPI');await page.viewport(1024,768)})
for(const width of [360,393,430])it(`all settings fit Android portrait ${width}px with readable row descriptions`,async()=>{
  await page.viewport(width,852)
  for(const spec of SETTINGS_PAGES){
    await act(async()=>{useLayoutStore.setState({settingsSection:spec.id});root.render(<StageSettings library/>)});await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))})
    expect(host.textContent, spec.id).not.toContain('设置页渲染失败')
    const body=host.querySelector<HTMLElement>('.stage-set-body')!
    expect(body.scrollWidth,spec.id).toBeLessThanOrEqual(Math.ceil(body.getBoundingClientRect().width)+1)
    for(const row of host.querySelectorAll<HTMLElement>('.stage-set-row')){
      const label=row.firstElementChild as HTMLElement
      expect(label.getBoundingClientRect().width,spec.id+' label width').toBeGreaterThan(width*0.6)
      const control=row.querySelector<HTMLElement>('.stage-set-row-ctl')
      if(control)expect(control.getBoundingClientRect().top,spec.id+' stacked control').toBeGreaterThanOrEqual(label.getBoundingClientRect().bottom-1)
    }
    if(width===393&&['appearance','stage-models','sync'].includes(spec.id))await page.screenshot({path:`.runtime/portrait-r3-${spec.id}-393.png`})
  }
})
