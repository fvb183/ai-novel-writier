import { describe,it,expect,vi } from 'vitest'
import { ModelSettingsStore } from '../model-settings-sync'
import { parseModelSettingsSnapshot,encodeModelSettings,decodeModelSettings } from '../../../src/shared/model-settings-sync'
import { registerModelSettingsSyncController } from '../../controllers/model-settings-sync-controller'
import type { ModelProfile,GlobalConfig } from '../../../src/shared/ipc-channels'
import type { GoogleDriveClient } from '../google-drive-client'
const key='SYNTHETIC_API_KEY_NOT_A_REAL_CREDENTIAL'
const model=(id='text',embedding=false):ModelProfile=>({id,name:embedding?'向量模型':'写作模型',provider:'custom',protocol:'openai',baseUrl:'https://synthetic.invalid/v1',apiKey:key,modelName:embedding?'embed-fixture':'text-fixture',temperature:0.7,maxTokens:embedding?0:4096,purposes:[embedding?'embedding':'generation'],...(embedding?{embeddingOptions:{chunkSize:800,chunkOverlap:100,batchSize:4}}:{reasoningOverride:'auto'})})
const snapshot=()=>parseModelSettingsSnapshot({format:'ai-novel-model-settings',version:1,models:[model(),model('embed',true)],defaultModelId:'text',defaultEmbeddingModelId:'embed',stageModelIds:{drafting:'text'}})
function local(initial=[model('local')]){
 let models=structuredClone(initial),config:GlobalConfig={theme:'light',defaultModelId:'local',editorFontSize:20,editorFontFamily:'font',autoSaveInterval:30,proxy:{enabled:true,type:'http',host:'127.0.0.1',port:17891}}
 let failConfig=false
 const store=new ModelSettingsStore({readModels:()=>structuredClone(models),readConfig:()=>structuredClone(config),writeModels:value=>{models=structuredClone(value)},updateConfig:update=>{if(failConfig)return false;config=update(config);return true}})
 return{store,get models(){return models},get config(){return config},edit(){models[0].apiKey='SYNTHETIC_LATER_EDIT'},fail(){failConfig=true}}
}
describe('explicit model settings transfer',()=>{
 it('roundtrips text/embedding keys and preferences without copying proxy, OAuth or paths',()=>{
  const f=local([model(),model('embed',true)]),s=f.store.snapshot()
  expect(decodeModelSettings(encodeModelSettings(s))).toEqual(s)
  expect(s.models.map(m=>m.apiKey)).toEqual([key,key])
  expect(JSON.stringify(s)).not.toMatch(/proxy|client_secret|oauth|17891|127\.0\.0\.1|projectPath/)
 })
 it.each([
  {proxy:{}},{googleTokens:{}},{models:[{...model(),script:'evil'}]},
  {models:[model(),model()]},{defaultEmbeddingModelId:'text'},
  {stageModelIds:{drafting:'missing'}},{models:[{...model(),baseUrl:'file:///secret'}]},
  {models:[{...model(),baseUrl:'https://user:pass@synthetic.invalid'}]},
 ])('rejects malformed or unexpected fields without revealing input',patch=>{
  expect(()=>parseModelSettingsSnapshot({...snapshot(),...patch})).toThrow('MODEL_SYNC_CONFIG_INVALID')
 })
 it('merges by ID, preserves other models and local proxy, and imports default/stage choices',()=>{
  const f=local([model('local'),{...model(),apiKey:'SYNTHETIC_OLD'}]),before=f.store.capture()
  expect(f.store.apply(snapshot(),before.revision,()=>{})).toBe(2)
  expect(f.models.map(m=>m.id)).toEqual(['local','text','embed'])
  expect(f.models.find(m=>m.id==='text')?.apiKey).toBe(key)
  expect(f.config).toMatchObject({theme:'light',defaultModelId:'text',defaultEmbeddingModelId:'embed',stageModelIds:{drafting:'text'},proxy:{host:'127.0.0.1',port:17891}})
 })
 it('does not overwrite a configuration edited after preview',()=>{
  const f=local(),revision=f.store.capture().revision;f.edit()
  expect(()=>f.store.apply(snapshot(),revision,()=>{})).toThrow('MODEL_SYNC_LOCAL_CHANGED')
  expect(f.models[0].apiKey).toBe('SYNTHETIC_LATER_EDIT');expect(f.models).toHaveLength(1)
 })
 it('restores models if preference writing fails',()=>{
  const f=local(),before=f.store.capture();f.fail()
  expect(()=>f.store.apply(snapshot(),before.revision,()=>{})).toThrow('MODEL_SYNC_LOCAL_CONFIG_INVALID')
  expect(f.models).toEqual(before.models);expect(f.config).toEqual(before.config)
 })
 it('checks project/account authority before model writes',()=>{
  const f=local(),before=f.store.capture()
  expect(()=>f.store.apply(snapshot(),before.revision,()=>{throw new Error('SYNC_SESSION_STALE')})).toThrow('SYNC_SESSION_STALE')
  expect(f.models).toEqual(before.models)
 })
})
describe('model settings controller capability',()=>{
 function fixture(){
  const handlers=new Map<string,Function>(),f=local();let active=true,account='account-a',cloud=encodeModelSettings(snapshot())
  const folder={id:'folder',name:'账户模型配置'}
  const client={accountId:async()=>account,modelSettingsFolders:async()=>[folder],checkModelSettingsFolder:async()=>folder,
   writeModelSettings:vi.fn(async(_f:string,_p:string,bytes:Uint8Array)=>{cloud=bytes}),readModelSettings:vi.fn(async()=>cloud)}
  const registration=registerModelSettingsSyncController({handle:(name,handler)=>{handlers.set(name,handler)},store:f.store,locks:new Set(),client:()=>client as unknown as GoogleDriveClient,
   captureAccount:()=>({generation:0,check:()=>{if(!active)throw new Error('SYNC_SESSION_STALE')}}),
   capture:()=>({projectId:'p',folderId:'folder',accountId:'account-a',check:()=>{if(!active)throw new Error('SYNC_SESSION_STALE')}})})
  const call=(action:string,input:Record<string,unknown>={},owner=1)=>handlers.get(`drive:model-settings-${action}`)!({sender:{id:owner}},{projectSession:{},...input})
  return{...f,f,call,client,registration,close:()=>{active=false},changeAccount:()=>{account='account-b'}}
 }
 it('returns only a redacted preview and applies keys/defaults after explicit apply',async()=>{
  const f=fixture();try{
   const response=await f.call('preview');expect(response.modelSettingsPreview).toMatchObject({total:2,embeddings:1,added:2})
   expect(JSON.stringify(response)).not.toContain(key)
   expect(f.f.models).toHaveLength(1)
   const applied=await f.call('apply',{token:response.modelSettingsPreview.token})
   expect(applied).toMatchObject({success:true,modelCount:2,modelSettingsSource:{kind:'account'}});expect(JSON.stringify(applied)).not.toContain(key)
   expect(f.f.models.find(m=>m.id==='embed')?.apiKey).toBe(key)
   await expect(f.call('apply',{token:response.modelSettingsPreview.token})).rejects.toThrow('MODEL_SYNC_PREVIEW_EXPIRED')
  }finally{f.registration.cancelAll()}
 })
 it('rejects a foreign window and clears pending credentials on authorization change',async()=>{
  const f=fixture();try{
   const response=await f.call('preview'),token=response.modelSettingsPreview.token
   await expect(f.call('apply',{token},2)).rejects.toThrow('MODEL_SYNC_PREVIEW_EXPIRED')
   f.registration.cancelAll();await expect(f.call('apply',{token})).rejects.toThrow('MODEL_SYNC_PREVIEW_EXPIRED')
   expect(f.f.models).toHaveLength(1)
  }finally{f.registration.cancelAll()}
 })
 it('rejects applying a preview under another Google account or an expired authority lease',async()=>{
  const f=fixture();try{const preview=await f.call('preview');f.changeAccount();await expect(f.call('apply',{token:preview.modelSettingsPreview.token})).rejects.toThrow('DRIVE_ACCOUNT_MISMATCH');expect(f.client.writeModelSettings).not.toHaveBeenCalled()
  }finally{f.registration.cancelAll()}
  const stale=fixture();try{stale.close();await expect(stale.call('preview')).rejects.toThrow('SYNC_SESSION_STALE');expect(stale.client.readModelSettings).not.toHaveBeenCalled()}finally{stale.registration.cancelAll()}
 })
 it('only uploads when explicitly requested and does not return keys',async()=>{
  const f=fixture();try{expect(f.client.writeModelSettings).not.toHaveBeenCalled();const result=await f.call('upload');expect(result).toMatchObject({success:true,modelCount:1,modelSettingsSource:{kind:'account'}});expect(JSON.stringify(result)).not.toContain(key)
  }finally{f.registration.cancelAll()}
 })
})
