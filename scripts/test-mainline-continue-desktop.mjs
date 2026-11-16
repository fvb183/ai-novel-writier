/** Focused packaged-app acceptance for continuing imported mainline chapters. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {createHash,randomUUID} from 'node:crypto'
import {_electron as electron} from 'playwright'
import * as stage from './redesign/pages/stage.mjs'
import {readBuildFingerprint} from './test-build-fingerprint.mjs'

const root=path.resolve(import.meta.dirname,'..')
const exe=path.join(root,'release/mainline-continue-20261030/win-unpacked/AI小说作家.exe')
if(process.argv.includes('--help')){console.log('Focused packaged GUI only: existing next-chapter navigation, imported 1/2 -> new mainline 3 save/reopen, immutable source/history and no branch creation. Uses isolated profiles and project copies. No model or cloud requests.');process.exit(0)}
assert.ok(fs.existsSync(exe),'Build the independent hotfix directory first')
const runId=randomUUID().slice(0,8),evidence=path.join(root,'.runtime/mainline-continue-20261030-ui',runId)
fs.mkdirSync(evidence,{recursive:true})
const source=path.join(root,'.runtime/project-copies/轮回迷宫x')
const realCopy=path.join(root,'.runtime/project-copies',`主线续章-旧项目-${runId}`)
const hash=value=>createHash('sha256').update(Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value)).digest('hex')
const inventory=(folder,prefix='')=>fs.readdirSync(folder,{withFileTypes:true}).flatMap(entry=>{
 const file=path.join(folder,entry.name),name=prefix+entry.name
 assert.equal(entry.isSymbolicLink(),false)
 return entry.isDirectory()?inventory(file,name+'/'):[{path:name,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))}]
}).sort((a,b)=>a.path.localeCompare(b.path))
const sourceBefore=inventory(source)
fs.cpSync(source,realCopy,{recursive:true,force:false,errorOnExist:true})
assert.deepEqual(inventory(realCopy),sourceBefore)
const profiles=Object.fromEntries(['canonical','legacy','electron','home','roaming','local'].map(name=>[name,path.join(evidence,name)]))
for(const directory of Object.values(profiles))fs.mkdirSync(directory,{recursive:true})
const report={startedAt:new Date().toISOString(),root,evidence,executable:exe,executableSha256:hash(fs.readFileSync(exe)),
 build:readBuildFingerprint(root),scope:'Focused mainline continuation only; not a repeated 20-check/cloud suite',checks:[],observedCalls:[],pageErrors:[],networkRequests:0,
 originalNovelRead:false,originalNovelModified:false,userProfileRead:false,userProcessesClosed:false,sourceCopyFiles:sourceBefore.length}
// The product deliberately refuses creation of a Lance-backed project beyond
// its supported path budget. Use a fresh C TEMP child for the new fixture,
// while the unmodified existing-project copy remains inside this checkout.
const fixtureParent=fs.mkdtempSync(path.join(os.tmpdir(),'mc-'))
assert.match(fixtureParent,/^C:/i)
report.fixtureParent=fixtureParent
let app,page,projectPath,session,step='launch'
const invoke=(channel,...args)=>page.evaluate(({channel,args})=>window.aiNovelAPI.invoke(channel,...args),{channel,args})
const success=result=>{assert.equal(result?.success,true,result?.error||'Public IPC operation failed');return result}
async function waitFor(read,predicate,label){const end=Date.now()+30_000;while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`MAINLINE_CONTINUE_TIMEOUT: ${label}`)}
async function launch(){
 const env={...process.env,AI_NOVEL_APP_DATA_HOME:profiles.canonical,AI_NOVEL_LEGACY_SOURCE_HOME:profiles.legacy,AI_NOVEL_VELA_HOME:profiles.legacy,
   HOME:profiles.home,USERPROFILE:profiles.home,APPDATA:profiles.roaming,LOCALAPPDATA:profiles.local}
 for(const key of ['ELECTRON_RUN_AS_NODE','VITE_DEV_SERVER_URL','AI_NOVEL_SMOKE_OPEN_PROJECT','AI_NOVEL_SMOKE_PROJECT_MARKER'])delete env[key]
 app=await electron.launch({cwd:root,executablePath:exe,args:[`--user-data-dir=${profiles.electron}`],env,timeout:30_000})
 page=await app.firstWindow({timeout:30_000});page.setDefaultTimeout(20_000)
 page.on('pageerror',()=>report.pageErrors.push('RENDERER_PAGE_ERROR'))
 await page.route(/^https?:\/\//,route=>{report.networkRequests++;return route.abort()})
 await stage.waitForStage(page)
 const runtime=await app.evaluate(({app,BrowserWindow,ipcMain})=>{
  globalThis.__mcProject=null;globalThis.__mcCalls=[];globalThis.__mcNetwork=0
  const open=ipcMain._invokeHandlers.get('project:open')
  ipcMain.removeHandler('project:open');ipcMain.handle('project:open',async(...args)=>{const r=await open(...args);if(r.success)globalThis.__mcProject={id:r.project.id,path:r.project.path,name:r.project.name,sessionLease:r.project.sessionLease};return r})
  for(const channel of ['story:fork-chapter','story:commit','db:blueprint-upsert','db:blueprint-upsert-many','llm:generate','llm:generate-stream']){
   const original=ipcMain._invokeHandlers.get(channel);if(!original)throw new Error('MAINLINE_CONTINUE_OBSERVER_UNAVAILABLE')
   ipcMain.removeHandler(channel);ipcMain.handle(channel,async(...args)=>{globalThis.__mcCalls.push(channel);return original(...args)})
  }
  globalThis.fetch=()=>{globalThis.__mcNetwork++;throw new Error('MAINLINE_CONTINUE_NETWORK_FORBIDDEN')}
  const window=BrowserWindow.getAllWindows()[0];window.setSize(1440,900)
  return {packaged:app.isPackaged,appPath:app.getAppPath(),visible:window.isVisible(),minimized:window.isMinimized()}
 })
 assert.equal(runtime.packaged,true);assert.match(runtime.appPath,/app\.asar$/i);assert.equal(runtime.visible,true)
 report.actualRuntime=runtime
 success({success:(await invoke('startup:get-state')).state==='ready'})
}
async function close(){
 if(!app)return
 report.observedCalls.push(...await app.evaluate(()=>globalThis.__mcCalls||[]).catch(()=>[]))
 report.networkRequests+=await app.evaluate(()=>globalThis.__mcNetwork||0).catch(()=>0)
 await app.evaluate(({app})=>app.quit()).catch(()=>{})
 await app.close().catch(()=>{});app=null
}
async function pick(directory,action){
 await app.evaluate(({dialog},directory)=>{globalThis.__mcDialog=dialog.showOpenDialog;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]})},directory)
 try{return await action()}finally{await app.evaluate(({dialog})=>{dialog.showOpenDialog=globalThis.__mcDialog;delete globalThis.__mcDialog})}
}
async function openUi(directory){
 await stage.dismissMigrationNotice(page)
 await app.evaluate(()=>{globalThis.__mcProject=null})
 await pick(directory,()=>page.getByRole('button',{name:'打开作品',exact:true}).click())
 const opened=await waitFor(()=>app.evaluate(()=>globalThis.__mcProject),value=>Boolean(value?.sessionLease),'UI open')
 assert.equal(path.resolve(opened.path),path.resolve(directory))
 projectPath=opened.path;session={projectId:opened.id,projectPath,leaseId:opened.sessionLease}
 await stage.waitForWork(page,opened.name)
 return opened
}
const readStory=async()=>success(await invoke('story:read',{projectSession:session})).data
const bpList=()=>invoke('db:blueprint-get-all',projectPath,session)
async function openBlueprint(){await stage.stageButton(page,'蓝图').click();await page.locator('.stage-bp .story-tree-card[data-story-node="chapter:1"]').waitFor()}
const inspector=()=>page.locator('.chapter-tree-inspector')
const selected=async()=>inspector().getAttribute('data-selected-story-node')
async function selectChapter(number){await page.locator(`.stage-bp .story-tree-card[data-story-node="chapter:${number}"] .story-tree-card-select`).click();await waitFor(selected,value=>value===`chapter:${number}`,'selected chapter')}
async function fingerprints(){
 return app.evaluate(({app},databasePath)=>{
  const require=process.getBuiltinModule('module').createRequire(`${app.getAppPath()}/package.json`),Database=require('better-sqlite3'),{createHash}=process.getBuiltinModule('crypto')
  const db=new Database(databasePath,{readonly:true,fileMustExist:true})
  try{
   const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name)
   const selected=names.filter(name=>['drafts','contents','reviews','revisions','finalized_draft_import_operations','chapter_finalization_heads'].includes(name)||name.startsWith('story_')).sort()
   const tables={}
   for(const name of selected){const rows=db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row)).sort();tables[name]={rows:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}}
   const outbox=db.prepare('SELECT finalization_id,draft_id,chapter_number,chapter_title,content_hash,content_revision,content_snapshot,target_file_name FROM finalization_outbox ORDER BY finalization_id').all()
   tables.finalization_outbox_immutable={rows:outbox.length,sha256:createHash('sha256').update(JSON.stringify(outbox)).digest('hex')}
   return {schemaVersion:db.pragma('user_version',{simple:true}),tables}
  }finally{db.close()}
 },path.join(projectPath,'.ai-novel/project.db'))
}
const pass=(name,details={})=>report.checks.push({name,passed:true,...details})
try{
 await launch()
 step='old-project-existing-next-only-navigates'
 const oldProject=await openUi(realCopy);await openBlueprint()
 const before=await fingerprints(),oldBlueprints=await bpList(),original=await readStory()
 const imports=[]
 for(const number of [1,2]){
  const node=original.nodes.find(node=>node.id===`chapter:${number}`)
  assert.equal(node.mainline.hasBlueprint,false);assert.equal(node.mainline.manuscriptStatus,'finalized')
  const drafts=await invoke('db:draft-list',number,projectPath,session)
  const finalized=drafts.filter(draft=>draft.status==='finalized').sort((a,b)=>b.version-a.version)[0]
  const full=await invoke('db:draft-get-full',finalized.id,projectPath,session)
  assert.equal(hash(full.content),hash(node.body))
  imports.push({chapterNumber:number,title:node.title,content:full.content,wordCount:full.wordCount})
 }
 await selectChapter(1);assert.equal(await page.locator('.stage-bp-card').count(),0)
 await inspector().getByRole('button',{name:'继续下一章',exact:true}).click();await waitFor(selected,value=>value==='chapter:2','existing second chapter')
 await page.locator('.story-tree-card[data-story-node="chapter:2"]').getByRole('button',{name:/^在「.+」后继续$/}).click()
 await waitFor(selected,value=>value==='chapter:3','existing third chapter')
 assert.equal(await page.locator('.stage-bp-card').getByLabel('章节标题',{exact:true}).inputValue(),oldBlueprints.find(bp=>bp.chapterNumber===3).title)
 assert.deepEqual(await bpList(),oldBlueprints);assert.deepEqual(await fingerprints(),before)
 pass('real-project-existing-next-navigates-without-writing',{chapters:[1,2,3],draftAndHistoryHashesPreserved:true})
 await stage.backToLibrary(page,oldProject.name)

 step='create-isolated-two-import-fixture'
 const grant=await pick(fixtureParent,()=>invoke('dialog:select-folder','project-create'))
 const created=success(await invoke('project:create',{name:`mc-${runId}`,parentGrantId:grant.grantId,genre:'奇幻',targetAudience:'一般读者',writingLanguage:'zh-CN'},`mc-create-${runId}`,null))
 const opened=success(await invoke('project:open',created.projectPath,`mc-seed-${runId}`,null))
 projectPath=opened.project.path;session={projectId:opened.project.id,projectPath,leaseId:opened.project.sessionLease}
 const imported=success(await invoke('db:draft-import-finalized-batch',{operationId:`mc-import-${runId}`,chapters:imports},projectPath,session))
 for(const draft of imported.receipt.drafts)success(await invoke('finalization:retry',draft.finalizationId,session))
 assert.deepEqual(await bpList(),[])
 success(await invoke('db:close',projectPath,session))
 await openUi(created.projectPath);await openBlueprint()
 const importedBefore=await fingerprints()
 assert.equal(importedBefore.tables.story_nodes.rows,0)
 for(const number of [1,2]){const node=(await readStory()).nodes.find(node=>node.id===`chapter:${number}`);assert.equal(node.mainline.hasBlueprint,false);assert.equal(node.mainline.manuscriptStatus,'finalized')}
 pass('two-public-imported-finalized-chapters-have-no-blueprints',{copiedBodiesOnly:true,source:'prepared project copy',blueprintCount:0,rawIndependentNodes:0})
 await selectChapter(1);await inspector().getByRole('button',{name:'继续下一章',exact:true}).click()
 await waitFor(selected,value=>value==='chapter:2','two-import existing next')
 assert.deepEqual(await bpList(),[]);assert.deepEqual(await fingerprints(),importedBefore)
 pass('import-one-continues-to-existing-two-without-fabricating-plan')

 step='continue-imported-tail-to-new-mainline-three'
 await page.screenshot({path:path.join(evidence,'imported-tail-with-continue.png'),fullPage:true})
 await page.locator('.story-tree-card[data-story-node="chapter:2"]').getByRole('button',{name:/^在「.+」后继续$/}).click()
 await waitFor(selected,value=>value==='chapter:3','new mainline three')
 await page.locator('.story-tree-card[data-story-node="chapter:3"][data-mainline="true"]').waitFor()
 const title=`SYNTHETIC_MAINLINE_THREE_${runId}`,card=page.locator('.stage-bp-card')
 await card.getByLabel('章节标题',{exact:true}).fill(title)
 await card.getByLabel(/主角小目标/).fill('保存独立验收的主线第三章规划。')
 await card.getByRole('button',{name:'保存此章',exact:true}).click()
 await waitFor(bpList,rows=>rows.length===1&&rows[0].chapterNumber===3&&rows[0].title===title,'saved mainline blueprint')
 const saved=await readStory()
 assert.deepEqual(saved.routes.find(route=>route.id==='mainline').nodeIds,['chapter:1','chapter:2','chapter:3'])
 assert.equal(saved.nodes.filter(node=>!node.mainline).length,0)
 assert.deepEqual(await invoke('db:draft-list',3,projectPath,session),[])
 assert.deepEqual(await fingerprints(),importedBefore)
 await page.screenshot({path:path.join(evidence,'saved-mainline-three.png'),fullPage:true})
 pass('tail-continue-creates-and-saves-mainline-three',{blueprintChapters:[3],route:['chapter:1','chapter:2','chapter:3'],thirdManuscriptFabricated:false,rawIndependentNodes:0,oldDraftHistoryPreserved:true})
 const targetPath=projectPath,oldLease=session.leaseId
 await close();await launch();await openUi(targetPath);assert.notEqual(session.leaseId,oldLease);await openBlueprint();await selectChapter(3)
 assert.equal(await page.locator('.stage-bp-card').getByLabel('章节标题',{exact:true}).inputValue(),title)
 assert.deepEqual((await bpList()).map(bp=>bp.chapterNumber),[3])
 assert.deepEqual(await fingerprints(),importedBefore)
 const reopened=await readStory();assert.equal(reopened.nodes.filter(node=>!node.mainline).length,0)
 await selectChapter(2);await inspector().getByRole('button',{name:'继续下一章',exact:true}).click();await waitFor(selected,value=>value==='chapter:3','reopened existing three')
 assert.equal((await bpList()).length,1);assert.deepEqual(await fingerprints(),importedBefore)
 pass('saved-three-survives-real-process-reopen-and-existing-next-remains-navigation',{newLease:true,blueprintCount:1,importedDraftAndHistoryHashesPreserved:true,rawIndependentNodes:0})
 report.importedHistory=importedBefore;report.fixtureProject=targetPath
 report.passed=true
}catch(error){report.passed=false;report.failure={step,name:error.name,message:error.message};process.exitCode=1;if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{})}
finally{
 await close()
 report.sourceCopyUnchanged=JSON.stringify(inventory(source))===JSON.stringify(sourceBefore)
 report.buildUnchangedDuringRun=JSON.stringify(readBuildFingerprint(root))===JSON.stringify(report.build)
 report.noBranchOrModelCalls=report.observedCalls.every(channel=>!['story:fork-chapter','story:commit','llm:generate','llm:generate-stream'].includes(channel))
 if(!report.sourceCopyUnchanged||!report.buildUnchangedDuringRun||!report.noBranchOrModelCalls||report.networkRequests||report.pageErrors.length){report.passed=false;process.exitCode=1}
 report.finishedAt=new Date().toISOString()
 const json=JSON.stringify(report,null,2)+'\n';fs.writeFileSync(path.join(evidence,'report.json'),json);fs.writeFileSync(path.join(root,'.runtime/mainline-continue-20261030-desktop-report.json'),json)
 console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,failure:report.failure,networkRequests:report.networkRequests,noBranchOrModelCalls:report.noBranchOrModelCalls,sourceCopyUnchanged:report.sourceCopyUnchanged,evidence}))
}
