import {it,expect}from'vitest'
import {randomUUID}from'node:crypto'
import {createDriveAssetHttpFixture}from'./drive-asset-http.fixture'
import {encodeModelSettings,decodeModelSettings,parseModelSettingsSnapshot}from'../../../src/shared/model-settings-sync'
it('uses real loopback HTTP for model creation, Unicode/key download and update without creating novel batches',async()=>{
 const projectId=randomUUID(),server=await createDriveAssetHttpFixture(projectId)
 try{
  const model={id:'text',name:'写作模型🙂',provider:'custom',protocol:'openai',modelName:'synthetic',baseUrl:'https://synthetic.invalid/v1',apiKey:'SYNTHETIC_HTTP_KEY',temperature:0.7,maxTokens:4096,purposes:['generation']}
  const snapshot=parseModelSettingsSnapshot({format:'ai-novel-model-settings',version:1,models:[model],defaultModelId:'text',defaultEmbeddingModelId:null,stageModelIds:{drafting:'text'}})
  const client=server.client();await client.writeModelSettings(server.folderId,projectId,encodeModelSettings(snapshot))
  expect(decodeModelSettings(await client.readModelSettings(server.folderId,projectId))).toEqual(snapshot)
  snapshot.models[0].apiKey='SYNTHETIC_HTTP_UPDATED';snapshot.models[0].name='更新后的模型🙂'
  await client.writeModelSettings(server.folderId,projectId,encodeModelSettings(snapshot))
  expect(decodeModelSettings(await client.readModelSettings(server.folderId,projectId))).toEqual(snapshot)
  expect(server.calls.filter(c=>c.method==='PATCH')).toHaveLength(1)
  expect([...server.files.values()].filter(f=>f.appProperties?.ainwKind==='model-settings')).toHaveLength(1)
  expect(server.committed).toEqual(['model-settings','model-settings'])
 }finally{await server.close()}
},20000)
