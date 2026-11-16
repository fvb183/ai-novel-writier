/** Two isolated Android backend instances using real bridge fs/SQLite/crypto.
 * Drive transport is a deterministic in-memory peer; no account or network is used. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {createNativeMock} from '../test/mobile-native-mock.mjs'
import {FakeAutomaticDrive} from '../test/fake-auto-drive.mjs'
const root=path.resolve(import.meta.dirname,'..'), output=path.join(root,'.runtime/auto-sync-r3-backend')
fs.mkdirSync(output,{recursive:true})
const run=fs.mkdtempSync(path.join(output,'run-')), drive=new FakeAutomaticDrive(), stages=[], devices=[]
const originalPlatform=process.platform, savedEnv=Object.fromEntries(['LOCALAPPDATA','AI_NOVEL_APP_DATA_HOME','AI_NOVEL_LEGACY_SOURCE_HOME','AI_NOVEL_VELA_HOME'].map(k=>[k,process.env[k]]))
const ok=(r,label='operation')=>{assert.equal(r?.success,true,label+': '+JSON.stringify(r));return r}
async function stage(name,fn){const start=Date.now();try{const detail=await fn();stages.push({name,passed:true,durationMs:Date.now()-start,...detail})}catch(error){stages.push({name,passed:false,error:error.stack});throw error}}
function select(device){globalThis.window=device.window;globalThis.AndroidBridge=device.bridge;globalThis.__androidResolve=device.resolve;globalThis.__androidEvent=device.event}
async function device(name){
  const nativeRoot=fs.mkdtempSync(path.join(path.dirname(root),'as-')), native=createNativeMock(nativeRoot,{virtualPaths:true}), window=new EventTarget(), selections=[]
  const counts=new Map();const bridge={sync:payload=>{const {op}=JSON.parse(payload);counts.set(op,(counts.get(op)||0)+1);return native.sync(payload)},request(id,payload){const {op}=JSON.parse(payload);const value=op==='dialog.open'?{canceled:false,filePaths:[selections.shift()]}:JSON.parse(native.sync(payload)).value;queueMicrotask(()=>globalThis.__androidResolve(id,{ok:true,value}))}}
  globalThis.window=window;globalThis.AndroidBridge=bridge
  const file=path.join(run,name+'.mjs');fs.copyFileSync(path.join(run,'backend.mjs'),file)
  const module=await import(pathToFileURL(file).href), api=module.startMobileBackend()
  for(const channel of [...module.mobileHandlers.keys()])if(channel.startsWith('drive:'))module.mobileHandlers.delete(channel)
  module.registerGoogleDriveSyncController({authorization:()=>({status:async()=>({platform:'android',available:true,configured:true,authorized:true,persistence:'google-play-services'}),accessToken:async interactive=>{assert.equal(interactive,false);return 'synthetic'},configure:async()=>{},disconnect:async()=>{},invalidate:async()=>{},cancel(){}}),client:(_token,check)=>drive.client(check)})
  const device={name,native,nativeRoot,window,bridge,counts,resolve:globalThis.__androidResolve,event:globalThis.__androidEvent,module,api,selections};devices.push(device);return device
}
async function create(d,name){select(d);d.selections.push('/android/files');const parent=await d.api.invoke('dialog:select-folder','project-create');const created=ok(await d.api.invoke('project:create',{name,parentGrantId:parent.grantId,genre:'奇幻',targetAudience:'一般',writingLanguage:'zh-CN'},'create-'+name));return open(d,created.projectPath)}
async function open(d,target){select(d);const before=await d.api.invoke('project:get-runtime-context');const opened=ok(await d.api.invoke('project:open',target,'open-'+Math.random(),before.activeProjectPath));d.path=target;d.context={projectPath:target,projectId:opened.project.id,leaseId:opened.project.sessionLease};return opened}
async function db(d,channel,...args){select(d);return d.api.invoke(channel,...args,d.path,d.context)}
async function edit(d,id,content){const old=await db(d,'db:draft-get-full',id);select(d);return d.api.invoke('db:draft-update-content',id,content,content.length,d.path,createHash('sha256').update(old.content).digest('hex'),d.context)}
try{
  for(const key of Object.keys(savedEnv))delete process.env[key]
  globalThis.document=Object.assign(new EventTarget(),{documentElement:{dataset:{}},querySelector:()=>null});globalThis.location=new URL('https://appassets.androidplatform.net/index.html')
  const aliases=Object.fromEntries(['fs','path','os','crypto','module','util','stream'].flatMap(n=>[[n,n],['node:'+n,n]]));Object.assign(aliases,{'node:fs/promises':'fs-promises','fs/promises':'fs-promises','node:child_process':'child-process',child_process:'child-process',electron:'electron','better-sqlite3':'sqlite','@lancedb/lancedb':'lancedb',yauzl:'yauzl'})
  await build({absWorkingDir:root,stdin:{contents:"export * from './mobile/backend'; export {mobileHandlers} from './mobile/shims/electron'; export {registerGoogleDriveSyncController} from './electron/controllers/google-drive-sync-controller'; export {readSyncKnowledgeDocuments} from './electron/vector-store';",resolveDir:root},outfile:path.join(run,'backend.mjs'),bundle:true,format:'esm',platform:'node',target:'es2022',banner:{js:"import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);"},plugins:[{name:'mobile-aliases',setup(builder){builder.onLoad({filter:/google-drive-automatic-sync\.ts$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('const code = error instanceof Error', 'console.error(error.stack); const code = error instanceof Error'),loader:'ts'}));builder.onResolve({filter:/.*/},args=>{if(args.path==='stream'&&args.importer.includes('node_modules'))return {path:'node:stream',external:true};if(args.path.endsWith('/services/google-drive-authorization'))return {path:path.join(root,'mobile/shims/google-drive-authorization.ts')};if(aliases[args.path])return {path:path.join(root,'mobile/shims',aliases[args.path]+'.ts')};if(args.path.endsWith('/security/windows-safe-file-system'))return {path:path.join(root,'mobile/shims/secure-fs.ts')}})}}]})
  Object.defineProperty(process,'platform',{value:'android',configurable:true})
  const a=await device('desktop-business-logic'), b=await device('phone-business-logic')
  let source, other, joined, draftId
  await stage('one-toggle-publishes-saved-book-and-full-knowledge',async()=>{
    await create(a,'自动同步合成小说');source={path:a.path,context:a.context}
    draftId=ok(await db(a,'db:draft-create',{chapterNumber:1,source:'write',content:'第一端保存的中文正文🙂',wordCount:12})).id
    ok(await db(a,'kb:import-text','完整知识原文\n\n铜钥匙在旧钟后。\n结尾原文🙂','来源.txt'))
    select(a);ok(await a.api.invoke('drive:toggle-project',{path:a.path,projectSession:a.context,enabled:true}))
    assert.equal((await drive.projects())[0].autoSync,true)
    return{cloudBooks:(await drive.projects()).length,assetObjects:[...drive.files.values()].filter(x=>x.file.appProperties.ainwKind==='asset').length}
  })
  await stage('empty-shelf-auto-fetch-registers-book-without-directory-dialog-or-open',async()=>{
    select(b);assert.equal((await b.api.invoke('project:recent-list')).length,0)
    const result=ok(await b.api.invoke('drive:auto-sync'));assert.equal(result.automatic.imported,1,JSON.stringify(result))
    const recents=await b.api.invoke('project:recent-list');assert.equal(recents.length,1);joined=recents[0].path
    assert.equal(recents[0].projectId,source.context.projectId);assert.equal((await b.api.invoke('project:get-runtime-context')).activeProjectPath,null)
    await open(b,joined);assert.equal((await db(b,'db:draft-get-full',draftId)).content,'第一端保存的中文正文🙂')
    const knowledge=await b.module.readSyncKnowledgeDocuments(joined+'/.ai-novel');assert.ok(knowledge[0].copy.content.includes('结尾原文🙂'))
    return{bookVisibleInRecentList:true,exactKnowledgeOriginal:true,automaticDirectory:true}
  })
  await stage('closed-book-updates-without-switching-the-active-book',async()=>{
    await create(b,'手机当前另一部小说');other={path:b.path,context:b.context}
    ok(await edit(a,draftId,'电脑端后续保存的正文🙂'))
    select(a);ok(await a.api.invoke('drive:exchange',{projectSession:a.context}))
    select(b);const result=ok(await b.api.invoke('drive:auto-sync'));assert.equal(result.automatic.updated,1,JSON.stringify(result))
    assert.equal((await b.api.invoke('project:get-runtime-context')).activeProjectPath,other.path)
    ok(await b.api.invoke('drive:auto-sync'));ok(await b.api.invoke('drive:auto-sync'));const before=b.counts.get('sqlite.open')||0;ok(await b.api.invoke('drive:auto-sync'));assert.equal(b.counts.get('sqlite.open')||0,before,'Idle closed books should not reopen SQLite every 15 seconds')
    await open(b,joined);assert.equal((await db(b,'db:draft-get-full',draftId)).content,'电脑端后续保存的正文🙂')
    return{closedProjectApplied:true,activeProjectUnchanged:true,idleClosedProjectNoSqliteReopen:true}
  })
  await stage('phone-save-returns-to-first-device-when-its-book-is-closed',async()=>{
    ok(await edit(b,draftId,'手机保存后自动返回电脑🙂'));select(b);ok(await b.api.invoke('drive:exchange',{projectSession:b.context}))
    await create(a,'电脑当前另一部小说');select(a);const result=ok(await a.api.invoke('drive:auto-sync'));assert.equal(result.automatic.updated,1,JSON.stringify(result))
    await open(a,source.path);assert.equal((await db(a,'db:draft-get-full',draftId)).content,'手机保存后自动返回电脑🙂')
    return{bidirectionalSavedChanges:true}
  })
  await stage('concurrent-saved-edits-retain-both-versions-and-never-auto-select-a-winner',async()=>{
    ok(await edit(a,draftId,'电脑并发保存的版本A'));ok(await edit(b,draftId,'手机并发保存的版本B'))
    select(a);ok(await a.api.invoke('drive:exchange',{projectSession:a.context}));select(b);const exchanged=ok(await b.api.invoke('drive:exchange',{projectSession:b.context}));assert.ok(exchanged.preview.conflicts.length)
    assert.ok(JSON.stringify(exchanged.preview).includes('电脑并发保存的版本A'));assert.ok(JSON.stringify(exchanged.preview).includes('手机并发保存的版本B'))
    await open(b,other.path);const result=ok(await b.api.invoke('drive:auto-sync'));assert.ok(result.automatic.conflicts.includes(source.context.projectId));await open(b,joined);assert.equal((await db(b,'db:draft-get-full',draftId)).content,'手机并发保存的版本B')
    return{bothVariantsPresent:true,noAutomaticWinner:true,localSavedBodyPreserved:true}
  })
  await stage('offline-retry-idempotence-and-toggle-off-preserve-both-local-copies',async()=>{
    select(b);drive.offline=true;const failure=await b.api.invoke('drive:auto-sync');assert.equal(failure.success,false);drive.offline=false
    ok(await b.api.invoke('drive:auto-sync'));ok(await b.api.invoke('drive:auto-sync'))
    assert.equal((await b.api.invoke('project:recent-list')).filter(p=>p.projectId===source.context.projectId).length,1)
    select(a);drive.offline=true;const paused=ok(await a.api.invoke('drive:toggle-project',{path:a.path,projectSession:a.context,enabled:false}));assert.equal(paused.drive.autoSync,false);assert.equal(paused.drive.preferencePending,true);drive.offline=false;ok(await a.api.invoke('drive:auto-sync'));assert.equal((await drive.projects())[0].autoSync,false)
    select(b);ok(await b.api.invoke('drive:auto-sync'));const prefs=ok(await b.api.invoke('drive:local-projects'));assert.equal(prefs.localProjects.find(p=>p.path===joined).enabled,false)
    assert.equal((await db(b,'db:draft-get-full',draftId)).content,'手机并发保存的版本B')
    return{retrySafe:true,noDuplicateBooks:true,disabledAcrossDevices:true}
  })
  await stage('explicit-local-deletion-is-not-undone-by-cloud-discovery',async()=>{
    select(a);ok(await a.api.invoke('drive:toggle-project',{path:a.path,projectSession:a.context,enabled:true}))
    select(b);ok(await b.api.invoke('project:delete',b.path,b.context.projectId,b.context.leaseId,b.context))
    const result=ok(await b.api.invoke('drive:auto-sync'));assert.equal(result.automatic.imported,0);assert.deepEqual(result.automatic.failures,[])
    assert.equal((await b.api.invoke('project:recent-list')).some(p=>p.projectId===source.context.projectId),false)
    assert.equal((await drive.projects()).length,1)
    return{localDeleteRespected:true,cloudBookRetained:true,noAutomaticReimport:true}
  })
  await stage('phone-first-upload-failure-retries-closed-book-and-publishes-only-a-complete-baseline',async()=>{
    await create(b,'手机首次上传中断');const pending={path:b.path,context:b.context}
    const body='手机独立新建作品的首次完整正文🙂';const id=ok(await db(b,'db:draft-create',{chapterNumber:1,source:'write',content:body,wordCount:body.length})).id
    const original=drive.publish;let failOnce=true
    drive.publish=async function(...args){if(failOnce){failOnce=false;throw new Error('DRIVE_REQUEST_TIMEOUT')}return original.apply(this,args)}
    select(b);const failed=await b.api.invoke('drive:toggle-project',{path:b.path,projectSession:b.context,enabled:true})
    assert.equal(failed.success,false);assert.equal(failed.error,'DRIVE_REQUEST_TIMEOUT')
    const before=(await drive.projects()).find(p=>p.projectId===pending.context.projectId);assert.equal(before.autoSync,false)
    assert.equal(ok(await b.api.invoke('drive:local-projects')).localProjects.find(p=>p.path===pending.path).enabled,true)
    await create(b,'手机写作另一部');select(b);const retried=ok(await b.api.invoke('drive:auto-sync'));assert.deepEqual(retried.automatic.failures,[])
    const after=(await drive.projects()).filter(p=>p.projectId===pending.context.projectId);assert.equal(after.length,1);assert.equal(after[0].folderId,before.folderId);assert.equal(after[0].autoSync,true)
    select(a);const received=ok(await a.api.invoke('drive:auto-sync'));assert.equal(received.automatic.imported,1)
    const target=(await a.api.invoke('project:recent-list')).find(p=>p.projectId===pending.context.projectId);assert.ok(target)
    await open(a,target.path);assert.equal((await db(a,'db:draft-get-full',id)).content,body)
    drive.publish=original
    return{explicitIntentPreserved:true,cloudFolderHiddenUntilBaseline:true,closedPhoneBookAutomaticallyRetried:true,oneFolder:true,otherReplicaReceivesExactBody:true}
  })
  await stage('phone-folder-creation-failure-retries-without-another-toggle',async()=>{
    await create(b,'手机云目录创建中断');const pending={path:b.path,context:b.context}
    const original=drive.createProject;let reserved,failOnce=true
    drive.createProject=async function(projectId,name,id,...rest){if(failOnce){failOnce=false;reserved=id;throw new Error('DRIVE_NETWORK_FAILED')}assert.equal(id,reserved);return original.call(this,projectId,name,id,...rest)}
    select(b);const failed=await b.api.invoke('drive:toggle-project',{path:b.path,projectSession:b.context,enabled:true});assert.equal(failed.error,'DRIVE_NETWORK_FAILED')
    assert.equal((await drive.projects()).some(p=>p.projectId===pending.context.projectId),false)
    await open(b,other.path);select(b);const retried=ok(await b.api.invoke('drive:auto-sync'));assert.deepEqual(retried.automatic.failures,[])
    const cloud=(await drive.projects()).filter(p=>p.projectId===pending.context.projectId);assert.equal(cloud.length,1);assert.equal(cloud[0].folderId,reserved);assert.equal(cloud[0].autoSync,true)
    drive.createProject=original
    return{reservedFolderReused:true,firstCreateRetried:true,noSecondToggle:true}
  })
}catch(error){process.exitCode=1;console.error(error.stack||error)}finally{
  for(const d of devices)d.native.close()
  Object.defineProperty(process,'platform',{value:originalPlatform,configurable:true});for(const [key,value]of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}
  const report={passed:stages.length===9&&stages.every(s=>s.passed),deviceTest:false,realGoogleDrive:false,stages,artifacts:run,nativeRoots:devices.map(d=>d.nativeRoot),backendSha256:fs.existsSync(path.join(run,'backend.mjs'))?createHash('sha256').update(fs.readFileSync(path.join(run,'backend.mjs'))).digest('hex'):null}
  fs.writeFileSync(path.join(root,'.runtime/auto-sync-r3-backend-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
}
