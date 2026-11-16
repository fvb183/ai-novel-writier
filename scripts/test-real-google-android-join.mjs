/** Real Drive is read-only. Join its existing domain book through the production
 * Android backend into an isolated native-mock filesystem; never exchange it. */
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
for (const key of ['AI_NOVEL_TEST_GOOGLE_DOCUMENT', 'AI_NOVEL_TEST_GOOGLE_EXPECTED_CLIENT', 'AI_NOVEL_TEST_GOOGLE_USER_DATA']) {
  if (!process.env[key]) throw new Error(`${key}_REQUIRED`)
}
const parent = path.join(root, '.runtime/real-google-android-join')
fs.mkdirSync(parent, { recursive: true })
const output = fs.mkdtempSync(path.join(parent, 'run-'))
const localState = JSON.parse(fs.readFileSync(path.join(process.env.AI_NOVEL_TEST_GOOGLE_USER_DATA, 'Local State'), 'utf8'))
if (!localState.os_crypt?.encrypted_key) throw new Error('TEST_OSCRYPT_KEY_MISSING')
fs.mkdirSync(path.join(output, 'electron-user'))
fs.writeFileSync(path.join(output, 'electron-user/Local State'), JSON.stringify({ os_crypt: localState.os_crypt }))

const aliases = Object.fromEntries(['fs', 'path', 'os', 'crypto', 'module', 'util', 'stream'].flatMap(name => [[name, name], ['node:' + name, name]]))
Object.assign(aliases, { 'node:fs/promises': 'fs-promises', 'fs/promises': 'fs-promises', 'node:child_process': 'child-process', child_process: 'child-process', electron: 'electron', 'better-sqlite3': 'sqlite', '@lancedb/lancedb': 'lancedb', yauzl: 'yauzl' })
await build({ absWorkingDir: root, stdin: { contents: `
export * from './mobile/backend';
export {mobileHandlers} from './mobile/shims/electron';
export {registerGoogleDriveSyncController} from './electron/controllers/google-drive-sync-controller';
export {GoogleDriveStateStore} from './electron/services/google-drive-state';
export {readSyncKnowledgeDocuments} from './electron/vector-store';
export {ProjectAssetBlobStore} from './electron/services/project-asset-blob-store';
export {captureProjectAssets,pendingProjectAssets} from './electron/services/project-sync-assets';
export {parseSyncKnowledgeDocument} from './src/shared/project-sync-knowledge';
export {getProjectDb} from './electron/database';
`, resolveDir: root }, outfile: path.join(output, 'android-backend.mjs'), bundle: true, format: 'esm', platform: 'node', target: 'es2022', banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" }, plugins: [{ name: 'production-mobile-aliases', setup(builder) {
  builder.onLoad({ filter: /google-drive-automatic-sync\.ts$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8').replace('const code = error instanceof Error', 'globalThis.__realAndroidJoinFailure?.(error); const code = error instanceof Error'), loader: 'ts' }))
  builder.onResolve({ filter: /.*/ }, args => {
    if (args.path === 'stream' && args.importer.includes('node_modules')) return { path: 'node:stream', external: true }
    if (args.path.endsWith('/services/google-drive-authorization')) return { path: path.join(root, 'mobile/shims/google-drive-authorization.ts') }
    if (aliases[args.path]) return { path: path.join(root, 'mobile/shims', aliases[args.path] + '.ts') }
    if (args.path.endsWith('/security/windows-safe-file-system')) return { path: path.join(root, 'mobile/shims/secure-fs.ts') }
  })
} }] })

const entry = `
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {app,safeStorage,session} from 'electron';
import {createNativeMock} from './test/mobile-native-mock.mjs';
import {DesktopGoogleDriveAuthorization} from './electron/services/google-drive-authorization';
import {DesktopNetworkTransport} from './electron/services/network-transport';
import {installNetworkTransport,networkFetch} from './electron/services/network-fetch';
import {GoogleDriveClient} from './electron/services/google-drive-client';
const output=process.env.AI_NOVEL_ANDROID_JOIN_OUTPUT,root=process.env.AI_NOVEL_ANDROID_JOIN_ROOT;
const report={passed:false,realGoogleDrive:true,realDomainBook:true,androidBackend:true,deviceTest:false,remoteWrites:0,remoteWriteAttempts:0,sourceProfileWritten:false,originalNovelWritten:false,joinedBookExchangeCalled:false,checks:[],stages:[],artifacts:output};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const pass=(name,detail={})=>report.checks.push({name,passed:true,...detail});
const originalPlatform=process.platform;
let native,step='startup';
const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('TEST_TOTAL_TIMEOUT')),300000);
const check=()=>{if(deadline.signal.aborted)throw new Error('TEST_TOTAL_TIMEOUT')};
// Application logs may contain a book title. Persist only explicit safe evidence.
console.log=()=>{};console.warn=()=>{};console.error=()=>{};
globalThis.__realAndroidJoinFailure=error=>{report.diagnostic={name:error?.name,nativeCode:/^[A-Z0-9_]+$/.test(error?.code||'')?error.code:undefined,frames:String(error?.stack||'').split('\\n').slice(1,10)}};
try{
 await app.whenReady();
 const source=process.env.AI_NOVEL_TEST_GOOGLE_DOCUMENT,configFile=path.join(path.dirname(source),'config.json'),localStateFile=path.join(process.env.AI_NOVEL_TEST_GOOGLE_USER_DATA,'Local State');
 const sourceFiles=[source,configFile,localStateFile],before=sourceFiles.map(file=>hash(fs.readFileSync(file)));
 let document=JSON.parse(fs.readFileSync(source,'utf8'));
 assert.equal(document.clientId,process.env.AI_NOVEL_TEST_GOOGLE_EXPECTED_CLIENT);
 const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
 installNetworkTransport(new DesktopNetworkTransport({initialProxy:()=>config.proxy,createSession:()=>{const transport=session.fromPartition('android-domain-join-'+randomUUID(),{cache:false});return{setProxy:value=>transport.setProxy(value),fetch:(input,init)=>transport.fetch(input instanceof URL?input.href:input,init),closeAllConnections:()=>transport.closeAllConnections()}}}));
 const authorization=new DesktopGoogleDriveAuthorization({read:()=>clone(document),write:value=>{document=clone(value)},storage:safeStorage,open:async()=>{throw new Error('TEST_INTERACTIVE_AUTH_FORBIDDEN')}});
 assert.equal((await authorization.status()).authorized,true);pass('source-dpapi-envelope-readable');
 let reads=0;
 const readOnlyFetch=async(input,init={})=>{
  const url=new URL(String(input)),method=String(init.method||'GET').toUpperCase();
  if(url.origin!=='https://www.googleapis.com'||!['GET','HEAD'].includes(method)){report.remoteWriteAttempts++;throw new Error('TEST_DRIVE_WRITE_FORBIDDEN')}
  reads++;return networkFetch(input,init);
 };
 const clientFactory=(checked=()=>{},signal=deadline.signal)=>new GoogleDriveClient(tokenSignal=>authorization.accessToken(false,tokenSignal),{fetch:readOnlyFetch,signal,revalidate:()=>{check();checked()}});
 const readClient=clientFactory();
 step='read-source-catalog';const catalog=await readClient.projects();assert.equal(catalog.length,1);assert.equal(catalog[0].autoSync,true);pass('one-enabled-original-cloud-book',{count:catalog.length});
 step='initialize-private-android-backend';
 // The host SQLite filename must stay short on Windows. Android still sees the
 // exact production /android/files paths, as in test-auto-sync-android-backend.
 const nativeRoot=fs.mkdtempSync(path.join(path.dirname(root),'as-'));native=createNativeMock(nativeRoot,{virtualPaths:true});
 report.nativeRoot=nativeRoot;
 globalThis.document=Object.assign(new EventTarget(),{documentElement:{dataset:{}},querySelector:()=>null});
 globalThis.location=new URL('https://appassets.androidplatform.net/index.html');globalThis.window=new EventTarget();
 globalThis.AndroidBridge={sync:payload=>native.sync(payload),request(id,payload){
  const request=JSON.parse(payload);
  if(request.op.startsWith('dialog.'))throw new Error('TEST_DIRECTORY_DIALOG_FORBIDDEN');
  const result=JSON.parse(native.sync(payload));queueMicrotask(()=>globalThis.__androidResolve(id,result));
 }};
 for(const key of ['LOCALAPPDATA','AI_NOVEL_APP_DATA_HOME','AI_NOVEL_LEGACY_SOURCE_HOME','AI_NOVEL_VELA_HOME'])delete process.env[key];
 process.env.AI_NOVEL_SYNC_PROJECTS_HOME='/android/files/Projects';
 Object.defineProperty(process,'platform',{value:'android',configurable:true});
 const module=await import(pathToFileURL(path.join(output,'android-backend.mjs')).href),api=module.startMobileBackend();
 for(const channel of [...module.mobileHandlers.keys()])if(channel.startsWith('drive:'))module.mobileHandlers.delete(channel);
 const state=new module.GoogleDriveStateStore();
 module.registerGoogleDriveSyncController({state,authorization:()=>({status:async()=>({platform:'android',available:true,configured:true,authorized:true,persistence:'google-play-services'}),accessToken:(interactive,signal)=>{assert.equal(interactive,false);return authorization.accessToken(false,signal)},configure:async()=>{throw new Error('TEST_CONFIGURE_FORBIDDEN')},disconnect:async()=>{throw new Error('TEST_DISCONNECT_FORBIDDEN')},invalidate:async()=>{},cancel(){}}),client:(_token,checked,signal)=>clientFactory(checked,signal)});
 api.on('drive:sync-progress',value=>{report.stages.push({stage:value.stage,completed:value.completed,total:value.total});check()});
 assert.equal((await api.invoke('project:recent-list')).length,0);
 step='auto-join-original-cloud-book';
 const result=await api.invoke('drive:auto-sync',{operationId:'real-original-android-join-'+randomUUID()});
 if(!result.success)throw new Error(result.error||'TEST_AUTO_SYNC_FAILED');
 if(result.automatic?.failures?.length)throw new Error(result.automatic.failures[0].error||'TEST_JOIN_FAILED');
 assert.equal(result.automatic.imported,1);assert.equal(result.automatic.updated,0);assert.deepEqual(result.automatic.conflicts,[]);
 const recents=await api.invoke('project:recent-list');assert.equal(recents.length,1);const joined=recents[0].path;
 assert.ok(joined.startsWith('/android/files/Projects/'));assert.equal(recents[0].projectId,catalog[0].projectId);
 const hostJoined=native.hostPath(joined),relative=path.relative(nativeRoot,hostJoined);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
 assert.equal((await api.invoke('project:get-runtime-context')).activeProjectPath,null);
 report.joinedPrivatePath=hostJoined;pass('real-domain-join-registers-one-private-shelf-book',{imported:1,recents:1,noDirectoryDialog:true,activeProjectUnchanged:true});
 step='open-joined-project';
 const runtime=await api.invoke('project:get-runtime-context'),opened=await api.invoke('project:open',joined,'original-join-open',runtime.activeProjectPath);
 if(!opened.success)throw new Error(opened.error||'TEST_PROJECT_OPEN_FAILED');assert.equal(opened.project.id,catalog[0].projectId);
 const context={projectPath:joined,projectId:opened.project.id,leaseId:opened.project.sessionLease};
 const sync=await api.invoke('sync:preview',{projectSession:context});if(!sync.success)throw new Error(sync.error||'TEST_SYNC_STATUS_FAILED');
 assert.equal(sync.status.pendingBatches,0);assert.equal(sync.status.conflicts,0);assert.equal(sync.preview.pendingBatches,0);assert.deepEqual(sync.preview.conflicts,[]);assert.deepEqual(sync.preview.missingBatchHashes,[]);
 const database=module.getProjectDb();assert.equal(database.pragma('integrity_check')[0].integrity_check,'ok');assert.equal(database.pragma('foreign_key_check').length,0);assert.equal(module.pendingProjectAssets(database).length,0);
 pass('real-schema-project-opens-with-no-pending-or-conflicts',{schemaIntegrity:true,pendingBatches:0,conflicts:0,pendingAssets:0});
 step='verify-original-knowledge-and-asset-bytes';
 const binding=Object.values(state.read().bindings)[0],store=new module.ProjectAssetBlobStore(joined+'/.ai-novel');
 let totalAssetBytes=0;
 for(const blob of binding.assetReferences||[]){const bytes=store.read(blob);assert.equal(bytes.byteLength,blob.byteSize);assert.equal(hash(bytes),blob.sha256);totalAssetBytes+=bytes.byteLength}
 const selected=module.captureProjectAssets(database).filter(record=>record.value.category==='knowledge');assert.ok(selected.length>0);
 const expected=selected.map(record=>module.parseSyncKnowledgeDocument(JSON.parse(store.read(record.value.blob).toString('utf8'))));
 const knowledge=await module.readSyncKnowledgeDocuments(joined+'/.ai-novel');assert.equal(knowledge.length,expected.length);
 let originals=0,originalBytes=0;
 for(const document of knowledge){const wanted=expected.find(item=>item.docId===document.docId);assert.ok(wanted);assert.equal(document.copy.availability,wanted.copy.availability);if(document.copy.availability==='available'){assert.equal(hash(Buffer.from(document.copy.content,'utf8')),document.copy.contentHash);assert.equal(document.copy.contentHash,wanted.copy.contentHash);assert.equal(document.copy.content,wanted.copy.content);originals++;originalBytes+=Buffer.byteLength(document.copy.content,'utf8')}}
 assert.ok(originals>0);pass('knowledge-originals-and-all-local-asset-bytes-match-cloud-hashes',{knowledgeDocuments:knowledge.length,originals,originalBytes,assetObjects:binding.assetReferences.length,totalAssetBytes,exactBytesVerified:true});
 step='verify-read-only-source-boundaries';
 assert.deepEqual(await readClient.projects(),catalog);assert.equal(report.remoteWriteAttempts,0);
 assert.deepEqual(sourceFiles.map(file=>hash(fs.readFileSync(file))),before);
 pass('no-remote-writes-and-source-profile-files-unchanged',{driveReadRequests:reads,remoteWriteAttempts:0,sourceFilesVerified:sourceFiles.length});report.passed=true;
}catch(error){report.failure={step,code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:error?.code==='ERR_ASSERTION'?'TEST_ASSERTION_FAILED':'TEST_OPERATION_FAILED',...(error?.code==='ERR_ASSERTION'?{operator:error.operator,actualType:typeof error.actual,expectedType:typeof error.expected}:{})};}
finally{clearTimeout(timer);try{native?.close()}catch{}Object.defineProperty(process,'platform',{value:originalPlatform,configurable:true});report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(root,'.runtime/r4-real-google-android-join-report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));app.exit(report.passed?0:1);}
`
await build({ absWorkingDir: root, stdin: { contents: entry, resolveDir: root, sourcefile: 'real-google-android-join.ts' }, outfile: path.join(output, 'main.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'es2022', external: ['electron'], banner: { js: "import {createRequire as __hostRequire} from 'node:module';const require=__hostRequire(import.meta.url);" } })
const bootstrap = path.join(output, 'bootstrap.cjs')
fs.writeFileSync(bootstrap, "const fs=require('node:fs'),path=require('node:path'),{app}=require('electron');const output=process.env.AI_NOVEL_ANDROID_JOIN_OUTPUT;app.setPath('userData',path.join(output,'electron-user'));app.whenReady().then(()=>import('./main.mjs')).catch(()=>{const report={passed:false,failure:{step:'bootstrap-import',code:'TEST_MODULE_START_FAILED'},artifacts:output,remoteWrites:0,sourceProfileWritten:false};fs.writeFileSync(path.join(process.env.AI_NOVEL_ANDROID_JOIN_ROOT,'.runtime/r4-real-google-android-join-report.json'),JSON.stringify(report,null,2));app.exit(1)});")
const env = { ...process.env, AI_NOVEL_ANDROID_JOIN_OUTPUT: output, AI_NOVEL_ANDROID_JOIN_ROOT: root }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap], { cwd: root, env, stdio: 'ignore', windowsHide: true })
const timer = setTimeout(() => { child.kill(); console.error('TEST_PROCESS_TIMEOUT') }, 360000)
child.on('error', error => { clearTimeout(timer); console.error(error.code || 'TEST_PROCESS_FAILED'); process.exitCode = 1 })
child.on('exit', code => { clearTimeout(timer); const file = path.join(root, '.runtime/r4-real-google-android-join-report.json'); if (fs.existsSync(file)) console.log(fs.readFileSync(file, 'utf8')); process.exitCode = code ?? 1 })
