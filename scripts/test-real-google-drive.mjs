/** Explicit real-account test. Reads an authorized local credential envelope without
 * changing it; writes only a separately named synthetic project when requested. */
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, '.runtime/real-drive-r4')
fs.mkdirSync(output, { recursive: true })
const previousReport = path.join(output, 'report.json')
if (fs.existsSync(previousReport)) fs.copyFileSync(previousReport, path.join(output, `previous-${Date.now()}.json`))
const synthetic = process.argv.includes('--synthetic')
for (const name of ['AI_NOVEL_TEST_GOOGLE_DOCUMENT', 'AI_NOVEL_TEST_GOOGLE_EXPECTED_CLIENT', 'AI_NOVEL_TEST_GOOGLE_USER_DATA']) {
  if (!process.env[name]) throw new Error(`${name}_REQUIRED`)
}
// Windows safeStorage uses the profile's DPAPI-protected OSCrypt key. Copy only
// that encrypted key into the isolated profile, never cookies or browsing state.
const sourceLocalState = JSON.parse(fs.readFileSync(path.join(process.env.AI_NOVEL_TEST_GOOGLE_USER_DATA, 'Local State'), 'utf8'))
if (!sourceLocalState.os_crypt?.encrypted_key) throw new Error('TEST_OSCRYPT_KEY_MISSING')
fs.mkdirSync(path.join(output, 'electron-user'), { recursive: true })
fs.writeFileSync(path.join(output, 'electron-user/Local State'), JSON.stringify({os_crypt:sourceLocalState.os_crypt}))
const entry = `
import assert from 'node:assert/strict';
import fs from 'node:fs'; import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {app,safeStorage,session} from 'electron';
import Database from 'better-sqlite3';
import {DesktopGoogleDriveAuthorization} from './electron/services/google-drive-authorization';
import {DesktopNetworkTransport} from './electron/services/network-transport';
import {installNetworkTransport,networkFetch} from './electron/services/network-fetch';
import {createDriveRequestBudget} from './electron/services/google-drive-request-budget';
import {GoogleDriveClient} from './electron/services/google-drive-client';
import {GoogleDriveStateStore} from './electron/services/google-drive-state';
import {GoogleDriveSyncService} from './electron/services/google-drive-sync-service';
import {ProjectSyncEngine,canonicalSyncJson} from './electron/services/project-sync-engine';
import {PROJECT_SYNC_SQL} from './electron/services/project-sync-schema';
const output=process.env.AI_NOVEL_REAL_DRIVE_REPORT_DIR;
app.setPath('userData',path.join(output,'electron-user'));
const report={runId:randomUUID(),startedAt:new Date().toISOString(),realGoogleDrive:true,syntheticCloudWrites:${synthetic},sourceCredentialWritten:false,originalNovelWritten:false,checks:[],stages:[]};
const handles=[];let step='startup',testClient,testAuthorization,testBinding;
const check=()=>{if(deadline.signal.aborted)throw new Error('DRIVE_SYNC_TIMEOUT')};
const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('DRIVE_SYNC_TIMEOUT')),300000);
const progress=p=>{check();report.stages.push({...p,at:new Date().toISOString()});if(report.stages.length>500)report.stages.shift()};
const pass=(name,detail={})=>{report.checks.push({name,passed:true,...detail});console.log(JSON.stringify({check:name,passed:true,...detail}))};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=v=>JSON.parse(JSON.stringify(v));
async function trashOwnedFixture(folderId,projectId,runId){
 const file=await testClient.metadata(folderId);
 assert.equal(file.appProperties?.ainwProject,projectId);
 assert.equal(file.name,'AI Novel Writer · Codex 同步核验 '+runId);
 if(file.trashed)return false;
 const budget=createDriveRequestBudget(undefined,30000);
 try{
  const token=await testAuthorization.accessToken(false,budget.signal);
  const response=await budget.race(networkFetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(folderId)+'?fields=id,trashed',{method:'PATCH',redirect:'error',signal:budget.signal,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({trashed:true})}));
  assert.equal(response.ok,true);await response.body?.cancel();
 }finally{budget.finish()}
 assert.equal((await testClient.metadata(folderId)).trashed,true);
 return true;
}
function state(){let doc=null;return new GoogleDriveStateStore({read:()=>clone(doc),write:value=>{doc=clone(value)}})}
function replica(projectId=randomUUID(),initial=true){
 const db=new Database(':memory:');handles.push(db);db.pragma('foreign_keys=ON');
 db.exec('CREATE TABLE drafts(id INTEGER PRIMARY KEY,chapter_number INTEGER,status TEXT,version INTEGER)');db.exec(PROJECT_SYNC_SQL);
 db.exec('CREATE TABLE author_records(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id))');
 const put=r=>db.prepare('INSERT OR REPLACE INTO author_records VALUES(?,?,?)').run(r.kind,r.id,canonicalSyncJson(r.value));
 const projection={capture:()=>db.prepare('SELECT * FROM author_records ORDER BY kind,id').all().map(r=>({...r,value:JSON.parse(r.value)})),validate:()=>{},apply:(_db,records)=>{db.prepare('DELETE FROM author_records').run();for(const r of records)put(r)}};
 if(initial)put({kind:'draft',id:'chapter-one',value:'真实 Drive 合成小说初稿🙂'});
 const engine=new ProjectSyncEngine(db,projectId,projection);
 return{engine,projectId,edit:(id,value)=>engine.captureMutation(()=>put({kind:'draft',id,value})),records:()=>projection.capture()};
}
try{
 await app.whenReady();
 const source=process.env.AI_NOVEL_TEST_GOOGLE_DOCUMENT,sourceBytes=fs.readFileSync(source),sourceHash=hash(sourceBytes);
 let document=JSON.parse(sourceBytes.toString('utf8'));
 assert.equal(document.clientId,process.env.AI_NOVEL_TEST_GOOGLE_EXPECTED_CLIENT);
 assert.ok(document.encrypted&&document.encryptedClientSecret);
 const config=JSON.parse(fs.readFileSync(path.join(path.dirname(source),'config.json'),'utf8'));
 installNetworkTransport(new DesktopNetworkTransport({initialProxy:()=>config.proxy,createSession:()=>{const s=session.fromPartition('real-drive-test-'+randomUUID(),{cache:false});return{setProxy:v=>s.setProxy(v),fetch:(input,init)=>s.fetch(input instanceof URL?input.href:input,init),closeAllConnections:()=>s.closeAllConnections()}}}));
 const authorization=new DesktopGoogleDriveAuthorization({read:()=>clone(document),write:value=>{document=clone(value)},storage:safeStorage,open:async()=>{throw new Error('TEST_INTERACTIVE_AUTH_NOT_ALLOWED')}});
 testAuthorization=authorization;
 assert.equal((await authorization.status()).authorized,true);
 pass('browser-client-id-matches-and-local-dpapi-envelope-readable');
 const client=new GoogleDriveClient(signal=>authorization.accessToken(false,signal),{signal:deadline.signal,revalidate:check});
 testClient=client;
 step='real-account-probe';const account=await client.accountId();assert.ok(account);pass('real-account-token-and-drive-api');
 const cleaned=new Set();let cleanedCount=0;
 for(const name of fs.readdirSync(output).filter(name=>name==='report.json'||/^previous-[0-9]+[.]json$/.test(name))){
  const previous=JSON.parse(fs.readFileSync(path.join(output,name),'utf8'));
  if(previous.syntheticCloudWrites&&previous.syntheticFolderId&&previous.syntheticProjectId&&!cleaned.has(previous.syntheticFolderId)){
   if(await trashOwnedFixture(previous.syntheticFolderId,previous.syntheticProjectId,previous.runId))cleanedCount++;cleaned.add(previous.syntheticFolderId);
  }
 }
 report.previousOwnTestFoldersTrashed=cleanedCount;
 const service=new GoogleDriveSyncService(state());
 step='read-existing-cloud-catalog';const projects=await client.projects();
 pass('real-cloud-catalog',{projects:projects.length,enabled:projects.filter(p=>p.autoSync!==false).length});
 for(const project of projects.filter(p=>p.autoSync!==false)){
  step='read-existing-cloud-book';const started=Date.now();
  const downloaded=await service.downloadProject(client,project.folderId,check,progress);
  assert.equal(downloaded.bundle.projectId,project.projectId);
  pass('existing-cloud-book-packages-verified',{durationMs:Date.now()-started,files:downloaded.binding.files.length,packageBytes:downloaded.binding.files.reduce((n,f)=>n+Number(f.size||0),0),batches:downloaded.bundle.batches.length,assetReferences:downloaded.binding.assetReferences?.length||0});
  const references=downloaded.binding.assetReferences||[];
  if(references.length){
   step='read-existing-author-asset-bytes';const files=await client.listObjects(project.folderId,project.projectId,'asset');let totalBytes=0;
   for(const blob of references){const file=files.find(f=>f.appProperties?.ainwDigest===blob.sha256);assert.ok(file);await client.downloadObject(file,project.folderId,project.projectId,'asset',blob,bytes=>{totalBytes+=bytes.byteLength})}
   pass('existing-knowledge-and-author-asset-bytes-verified',{objects:references.length,totalBytes});
  }
 }
 if(${synthetic}){
  step='synthetic-publish';const a=replica(),storeA=state(),serviceA=new GoogleDriveSyncService(storeA);a.engine.enable();
  const binding=await serviceA.bind(client,a.projectId,a.engine.status().replicaId,'Codex 同步核验 '+report.runId,undefined,check);
  testBinding=binding;
  report.syntheticFolderId=binding.folderId;report.syntheticProjectId=a.projectId;
  await client.setProjectAutoSync(binding.folderId,a.projectId,false);
  await serviceA.exchange(client,a.projectId,a.engine,check);
  pass('synthetic-book-published-in-isolated-paused-folder');
  step='synthetic-second-replica-join';const storeB=state(),serviceB=new GoogleDriveSyncService(storeB),incoming=await serviceB.downloadProject(client,binding.folderId,check,progress);
  const b=replica(a.projectId,false);assert.equal(b.engine.join(incoming.bundle).applied,true);serviceB.rememberJoined(incoming.binding,b.engine.status().replicaId);
  assert.deepEqual(a.records(),b.records());assert.notEqual(a.engine.status().replicaId,b.engine.status().replicaId);
  pass('synthetic-second-replica-pulled-and-exact-content-verified');
  step='synthetic-two-way-saved-edits';a.edit('chapter-one','电脑保存的后续正文🙂');b.edit('chapter-two','手机新增的第二章🙂');
  step='synthetic-desktop-new-save-upload';await serviceA.exchange(client,a.projectId,a.engine,check);
  step='synthetic-phone-receive-apply';const toB=await serviceB.exchange(client,a.projectId,b.engine,check);
  report.toPhone={pending:toB.preview.pendingBatches,conflicts:toB.preview.conflicts.length,missing:toB.preview.missingBatchHashes.length,downloaded:toB.downloaded};
  assert.equal(b.engine.apply(toB.preview.token).applied,true);
  step='synthetic-phone-new-save-upload';await serviceB.exchange(client,a.projectId,b.engine,check);
  step='synthetic-desktop-receive-apply';const toA=await serviceA.exchange(client,a.projectId,a.engine,check);
  report.toDesktop={pending:toA.preview.pendingBatches,conflicts:toA.preview.conflicts.length,missing:toA.preview.missingBatchHashes.length,downloaded:toA.downloaded};
  assert.equal(a.engine.apply(toA.preview.token).applied,true);
  step='synthetic-incremental-eventual-convergence';let rounds=0;const convergenceEnd=Date.now()+90000;
  while(JSON.stringify(a.records())!==JSON.stringify(b.records())&&Date.now()<convergenceEnd){
   await new Promise(resolve=>setTimeout(resolve,2000));rounds++;
   const phone=await serviceB.exchange(client,a.projectId,b.engine,check);assert.equal(phone.preview.conflicts.length,0);assert.equal(b.engine.apply(phone.preview.token).applied,true);
   const desktop=await serviceA.exchange(client,a.projectId,a.engine,check);assert.equal(desktop.preview.conflicts.length,0);assert.equal(a.engine.apply(desktop.preview.token).applied,true);
  }
  assert.deepEqual(a.records(),b.records());assert.equal(a.records().length,2);
  pass('synthetic-two-way-real-drive-converged',{additionalPollingRounds:rounds});
  step='synthetic-idempotent-repeat';await serviceA.exchange(client,a.projectId,a.engine,check);
  const repeat=await serviceA.exchange(client,a.projectId,a.engine,check);assert.equal(repeat.uploaded,false);assert.equal(repeat.preview.pendingBatches,0);
  await client.setProjectAutoSync(binding.folderId,a.projectId,false);
  assert.equal((await client.projects()).find(p=>p.folderId===binding.folderId).autoSync,false);
  report.syntheticSyncDisabled=true;
  pass('repeat-safe-and-test-book-paused');
 }
 assert.equal(hash(fs.readFileSync(source)),sourceHash);pass('source-credential-file-unchanged');
 report.passed=true;
}catch(error){report.passed=false;report.failure={step,name:error?.name,code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:error?.code==='ERR_ASSERTION'?'TEST_ASSERTION_FAILED':'TEST_OPERATION_FAILED',...(error?.code==='ERR_ASSERTION'?{operator:error.operator,actualType:typeof error.actual,expectedType:typeof error.expected}: {})};console.error(JSON.stringify(report.failure));}
finally{if(testClient&&testBinding&&!deadline.signal.aborted){try{await testClient.setProjectAutoSync(testBinding.folderId,testBinding.projectId,false);report.syntheticSyncDisabled=true;await trashOwnedFixture(testBinding.folderId,testBinding.projectId,report.runId);report.syntheticTestFolderRetained=false;report.syntheticFolderTrashed=true}catch{report.syntheticCleanupFailed=true}}clearTimeout(timer);for(const handle of handles)handle.close();report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1);}
`
const main = path.join(output, 'main.mjs')
await build({absWorkingDir:root,stdin:{contents:entry,resolveDir:root,sourcefile:'real-google-drive-test.ts'},outfile:main,bundle:true,platform:'node',format:'esm',target:'es2022',external:['electron','better-sqlite3'],banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"}})
const env={...process.env,AI_NOVEL_REAL_DRIVE_REPORT_DIR:output};delete env.ELECTRON_RUN_AS_NODE
const bootstrap=path.join(output,'bootstrap.cjs')
fs.writeFileSync(bootstrap,"const fs=require('node:fs'),path=require('node:path'),{app}=require('electron');const out=process.env.AI_NOVEL_REAL_DRIVE_REPORT_DIR;fs.appendFileSync(path.join(out,'startup.log'),'bootstrap\\n');app.setPath('userData',path.join(out,'electron-user'));app.whenReady().then(()=>{fs.appendFileSync(path.join(out,'startup.log'),'ready\\n');return import('./main.mjs')}).catch(error=>{fs.appendFileSync(path.join(out,'startup.log'),'module-failed '+error.name+' '+error.message+'\\n');app.exit(1)});")
const child=spawn(path.join(root,'node_modules/electron/dist/electron.exe'),[bootstrap,'--enable-logging',`--log-file=${path.join(output,'electron.log')}`],{cwd:root,env,stdio:'inherit',windowsHide:true})
const timeout=setTimeout(()=>{child.kill();console.error('TEST_PROCESS_TIMEOUT')},360000)
child.on('error',error=>{clearTimeout(timeout);console.error(error.code||'TEST_PROCESS_FAILED');process.exitCode=1})
child.on('exit',code=>{clearTimeout(timeout);process.exitCode=code??1})
