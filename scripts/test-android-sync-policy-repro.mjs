/** Two isolated Android backend instances using real bridge fs/SQLite/crypto.
 * Drive transport is a deterministic in-memory peer; no account or network is used. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {execFileSync} from 'node:child_process'
import {createNativeMock} from '../test/mobile-native-mock.mjs'
import {FakeAutomaticDrive} from '../test/fake-auto-drive.mjs'
const root=path.resolve(import.meta.dirname,'..'), output=path.join(root,'.runtime/legacy-sync-policy-control')
fs.mkdirSync(output,{recursive:true})
const run=fs.mkdtempSync(path.join(output,'run-')), drive=new FakeAutomaticDrive(), stages=[], devices=[]
const originalPlatform=process.platform, savedEnv=Object.fromEntries(['LOCALAPPDATA','AI_NOVEL_APP_DATA_HOME','AI_NOVEL_LEGACY_SOURCE_HOME','AI_NOVEL_VELA_HOME'].map(k=>[k,process.env[k]]))
const ok=(r,label='operation')=>{assert.equal(r?.success,true,label+': '+JSON.stringify(r));return r}
async function stage(name,fn){const start=Date.now();try{const detail=await fn();stages.push({name,passed:true,durationMs:Date.now()-start,...detail})}catch(error){stages.push({name,passed:false,error:error.stack});throw error}}
function select(device){globalThis.window=device.window;globalThis.AndroidBridge=device.bridge;globalThis.__androidResolve=device.resolve;globalThis.__androidEvent=device.event}
async function device(name,legacy=false){
  const nativeRoot=fs.mkdtempSync(path.join(path.dirname(root),'as-')), native=createNativeMock(nativeRoot,{virtualPaths:true}), window=new EventTarget(), selections=[]
  const counts=new Map();const bridge={sync:payload=>{const {op}=JSON.parse(payload);counts.set(op,(counts.get(op)||0)+1);const response=native.sync(payload);if(op==='fs.link'&&!JSON.parse(response).ok)counts.set('fs.link.denied',(counts.get('fs.link.denied')||0)+1);return response},request(id,payload){const {op}=JSON.parse(payload);const value=op==='dialog.open'?{canceled:false,filePaths:[selections.shift()]}:JSON.parse(native.sync(payload)).value;queueMicrotask(()=>globalThis.__androidResolve(id,{ok:true,value}))}}
  globalThis.window=window;globalThis.AndroidBridge=bridge
  const file=path.join(run,name+'.mjs');fs.copyFileSync(path.join(run,legacy?'legacy.mjs':'backend.mjs'),file)
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
  await build({absWorkingDir:root,stdin:{contents:"export * from './mobile/backend'; export {mobileHandlers} from './mobile/shims/electron'; export {registerGoogleDriveSyncController} from './electron/controllers/google-drive-sync-controller'; export {readSyncKnowledgeDocuments} from './electron/vector-store';",resolveDir:root},outfile:path.join(run,'legacy.mjs'),bundle:true,format:'esm',platform:'node',target:'es2022',banner:{js:"import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);"},plugins:[{name:'mobile-aliases',setup(builder){builder.onLoad({filter:/(?:project-asset-blob-store|project-asset-materializer|project-sync-transfer|google-drive-sync-controller)\.ts$/},args=>({contents:execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'show','29a734a:'+path.relative(root,args.path).replaceAll('\\','/')],{cwd:root,encoding:'utf8',windowsHide:true}),loader:'ts'}));builder.onLoad({filter:/google-drive-automatic-sync\.ts$/},args=>({contents:fs.readFileSync(args.path,'utf8').replace('const code = error instanceof Error', 'console.error(error.stack); const code = error instanceof Error'),loader:'ts'}));builder.onResolve({filter:/.*/},args=>{if(args.path==='stream'&&args.importer.includes('node_modules'))return {path:'node:stream',external:true};if(args.path.endsWith('/services/google-drive-authorization'))return {path:path.join(root,'mobile/shims/google-drive-authorization.ts')};if(aliases[args.path])return {path:path.join(root,'mobile/shims',aliases[args.path]+'.ts')};if(args.path.endsWith('/security/windows-safe-file-system'))return {path:path.join(root,'mobile/shims/secure-fs.ts')}})}}]})
  Object.defineProperty(process,'platform',{value:'android',configurable:true})
  const modern=await device('modern-seed'), legacy=await device('legacy-phone',true)
  let source, draftId
  await stage('fixed-backend-publishes-exact-synthetic-book-with-hardlinks-denied',async()=>{
    await create(modern,'新修复合成云端作品');source={path:modern.path,context:modern.context}
    draftId=ok(await db(modern,'db:draft-create',{chapterNumber:1,source:'write',content:'仅用于同步对照的合成正文',wordCount:14})).id
    ok(await db(modern,'kb:import-text','严格Android策略同步原文\n\n原文尾部一致。','合成来源.txt'))
    select(modern);ok(await modern.api.invoke('drive:toggle-project',{path:modern.path,projectSession:modern.context,enabled:true}))
    assert.equal(modern.counts.get('fs.link')||0,0)
    assert.ok(modern.counts.get('fs.installExclusive')>0)
    return{hardLinkAttempts:0,exclusiveInstalls:modern.counts.get('fs.installExclusive')}
  })
  await stage('legacy-phone-prepare-reproduces-user-DRIVE_PREPARE_FAILED',async()=>{
    await create(legacy,'旧版本地同步合成作品')
    ok(await db(legacy,'kb:import-text','旧版需要冻结的知识原文。','旧版原文.txt'))
    select(legacy);const result=await legacy.api.invoke('drive:toggle-project',{path:legacy.path,projectSession:legacy.context,enabled:true})
    assert.equal(result.success,false);assert.equal(result.error,'DRIVE_PREPARE_FAILED')
    assert.ok(legacy.counts.get('fs.link.denied')>0)
    return{error:result.error,deniedHardLinks:legacy.counts.get('fs.link.denied')}
  })
  await stage('legacy-phone-cloud-import-reproduces-user-DRIVE_OPERATION_FAILED',async()=>{
    select(legacy);const before=legacy.counts.get('fs.link.denied')||0
    const result=ok(await legacy.api.invoke('drive:auto-sync'))
    const failure=result.automatic.failures.find(item=>item.projectId===source.context.projectId)
    assert.ok(failure);assert.equal(failure.error,'DRIVE_OPERATION_FAILED')
    assert.ok((legacy.counts.get('fs.link.denied')||0)>before)
    assert.equal((await legacy.api.invoke('project:recent-list')).some(p=>p.projectId===source.context.projectId),false)
    return{error:failure.error,deniedHardLinks:(legacy.counts.get('fs.link.denied')||0)-before,originalCloudChanged:false}
  })
}catch(error){process.exitCode=1;console.error(error.stack||error)}finally{
  for(const d of devices)d.native.close()
  Object.defineProperty(process,'platform',{value:originalPlatform,configurable:true});for(const [key,value]of Object.entries(savedEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value}
  const report={passed:stages.length===3&&stages.every(s=>s.passed),deviceTest:false,realGoogleDrive:false,legacyCommit:"29a734a",policy:"Android SELinux hard links denied with EPERM",stages,artifacts:run,nativeRoots:devices.map(d=>d.nativeRoot),backendSha256:fs.existsSync(path.join(run,'backend.mjs'))?createHash('sha256').update(fs.readFileSync(path.join(run,'backend.mjs'))).digest('hex'):null}
  fs.writeFileSync(path.join(root,'.runtime/r6-legacy-policy-repro.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1
}
