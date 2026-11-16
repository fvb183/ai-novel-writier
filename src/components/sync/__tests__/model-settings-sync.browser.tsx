import { act } from 'react'
import { createRoot,type Root } from 'react-dom/client'
import {beforeEach,afterEach,it,expect,vi}from'vitest'
import {page}from'vitest/browser'
import ModelSettingsSyncSection from '../ModelSettingsSyncSection'
import {useProjectStore}from'../../../stores/project-store'
import {useLLMStore}from'../../../stores/llm-store'
import {useLocaleStore}from'../../../stores/locale-store'
import {setActiveProjectSessionContext}from'../../../shared/project-session-context'
import '../project-sync.css'
;(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true
const session={projectId:'synthetic-model-project',projectPath:'D:/synthetic-model-project',leaseId:'synthetic-lease'},key='SYNTHETIC_NOT_REAL_API_KEY'
let host:HTMLDivElement,root:Root,invoke:ReturnType<typeof vi.fn>
const originalModels=useLLMStore.getState(),originalProjects=useProjectStore.getState()
const click=async(name:string)=>{await act(async()=>{(await page.getByRole('button',{name,exact:true}).element() as HTMLButtonElement).click()})}
beforeEach(async()=>{
 await page.viewport(1024,768);useLocaleStore.setState({locale:'zh-CN'});setActiveProjectSessionContext(session)
 useProjectStore.setState({currentProject:{id:session.projectId,path:session.projectPath,sessionLease:session.leaseId,name:'合成作品'}as never})
 useLLMStore.setState({loaded:true,models:[],stageModelIds:{},defaultModelId:null,defaultEmbeddingModelId:null})
 invoke=vi.fn(async(channel:string)=>{
  if(channel==='drive:model-settings-upload')return{success:true,modelCount:2}
  if(channel==='drive:model-settings-preview')return{success:true,modelSettingsPreview:{token:'preview-token',modelNames:['写作模型','向量模型'],total:2,embeddings:1,added:2,updated:0}}
  if(channel==='drive:model-settings-apply')return{success:true,modelCount:2}
  if(channel==='drive:model-settings-discard')return{success:true}
  if(channel==='llm:list-models')return[{id:'text',purposes:['generation'],apiKey:key},{id:'embed',purposes:['embedding'],apiKey:key}]
  if(channel==='llm:get-default-model')return'text'
  if(channel==='llm:get-default-embedding-model')return'embed'
  if(channel==='llm:get-stage-models')return{drafting:'text'}
  throw new Error('unexpected channel')
 })
 Object.defineProperty(window,'aiNovelAPI',{configurable:true,value:{invoke,on:()=>()=>{}}})
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root.render(<ModelSettingsSyncSection session={session}/>))
})
afterEach(async()=>{await act(async()=>root.unmount());host.remove();useLLMStore.setState(originalModels);useProjectStore.setState(originalProjects);setActiveProjectSessionContext(null);Reflect.deleteProperty(window,'aiNovelAPI')})
it('uploads only after an explicit click and explains keys/global scope without asking for a password',async()=>{
 expect(invoke).not.toHaveBeenCalled();expect(host.textContent).toContain('包括 API Key');expect(host.textContent).toContain('影响本机所有作品');expect(host.querySelector('input[type=password]')).toBeNull()
 await click('上传本机模型配置');await expect.element(page.getByText('已上传本机 2 个模型配置。可在另一端读取并应用。')).toBeVisible()
 expect(invoke).toHaveBeenCalledWith('drive:model-settings-upload',{projectSession:session})
})
it('previews without key disclosure or local changes, then refreshes both model defaults after apply',async()=>{
 await click('读取云端模型配置');await expect.element(page.getByRole('button',{name:'应用云端模型配置'})).toBeVisible()
 expect(host.textContent).not.toContain(key);expect(useLLMStore.getState().models).toEqual([])
 await click('应用云端模型配置');await expect.element(page.getByText(/已应用 2 个模型/)).toBeVisible()
 expect(useLLMStore.getState()).toMatchObject({loaded:true,defaultModelId:'text',defaultEmbeddingModelId:'embed',stageModelIds:{drafting:'text'}})
 expect(invoke).toHaveBeenCalledWith('drive:model-settings-apply',{projectSession:session,token:'preview-token'})
 expect(host.textContent).not.toContain(key)
})
it('discards a preview without importing credentials',async()=>{
 await click('读取云端模型配置');await click('取消导入')
 expect(invoke.mock.calls.some(([channel])=>channel==='drive:model-settings-apply')).toBe(false)
 expect(useLLMStore.getState().models).toEqual([])
 expect(invoke).toHaveBeenCalledWith('drive:model-settings-discard',{projectSession:session})
})
it('keeps preview and apply controls reachable at phone width',async()=>{
 await page.viewport(393,852);host.style.width='100%';await click('读取云端模型配置')
 await expect.element(page.getByRole('button',{name:'应用云端模型配置'})).toBeVisible()
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
})
it('explains stale local settings and retains the existing model configuration',async()=>{
 await click('读取云端模型配置');invoke.mockResolvedValueOnce({success:false,error:'MODEL_SYNC_LOCAL_CHANGED'})
 await click('应用云端模型配置');await expect.element(page.getByText(/本机模型设置已变化/)).toBeVisible();expect(useLLMStore.getState().models).toEqual([])
})
it('transfers account settings from the library without any project session',async()=>{
 setActiveProjectSessionContext(null);useProjectStore.setState({currentProject:null})
 await act(async()=>root.render(<ModelSettingsSyncSection/>))
 await page.viewport(393,852)
 expect(invoke).not.toHaveBeenCalled()
 await click('上传本机模型配置')
 expect(invoke).toHaveBeenCalledWith('drive:model-settings-upload',{})
 await click('读取云端模型配置');await click('应用云端模型配置')
 expect(invoke).toHaveBeenCalledWith('drive:model-settings-preview',{})
 expect(invoke).toHaveBeenCalledWith('drive:model-settings-apply',{token:'preview-token'})
 expect(host.textContent).not.toContain(key)
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
})
it('lists legacy sources only on request and previews only the selected book',async()=>{
 const original=invoke.getMockImplementation() as (...args:unknown[])=>Promise<unknown>
 invoke.mockImplementation(async(channel:string,...args:unknown[])=>channel==='drive:model-settings-sources'
  ?{success:true,modelSettingsSources:[{kind:'project',folderId:'legacy-a',projectId:'a',name:'旧作品甲'},{kind:'project',folderId:'legacy-b',projectId:'b',name:'旧作品乙'}]}
  :original(channel,...args))
 const details=host.querySelector('details')!;await act(async()=>{details.open=true})
 expect(invoke).not.toHaveBeenCalled()
 await click('读取旧版配置来源')
 expect(host.querySelector<HTMLButtonElement>('select + button')?.disabled??true).toBe(true)
 expect(invoke.mock.calls.some(([channel])=>channel==='drive:model-settings-preview')).toBe(false)
 const select=host.querySelector<HTMLSelectElement>('select')!
 await act(async()=>{select.value='legacy-b';select.dispatchEvent(new Event('change',{bubbles:true}))})
 await click('读取所选旧配置')
 expect(invoke).toHaveBeenCalledWith('drive:model-settings-preview',{projectSession:session,sourceFolderId:'legacy-b'})
 expect(invoke.mock.calls.some(([channel])=>channel==='drive:model-settings-apply')).toBe(false)
})
it('clears an old import preview when uploading the current local settings',async()=>{
 await click('读取云端模型配置')
 await expect.element(page.getByRole('button',{name:'应用云端模型配置'})).toBeVisible()
 await click('上传本机模型配置')
 expect(host.querySelector('button')?.textContent).toBe('上传本机模型配置')
 expect(host.textContent).not.toContain('应用云端模型配置')
 expect(invoke.mock.calls.some(([channel])=>channel==='drive:model-settings-apply')).toBe(false)
})
