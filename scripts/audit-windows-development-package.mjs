/** Path-only privacy inventory plus hashes binding a development ASAR to its build. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readBuildFingerprint } from './test-build-fingerprint.mjs'
import { WINDOWS_EXECUTABLE_NAME } from './product-identity.mjs'
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url)
let asar
try{asar=await import('@electron/asar')}catch{
  const builderRequire=createRequire(require.resolve('electron-builder'))
  const appRequire=createRequire(builderRequire.resolve('app-builder-lib'))
  asar=await import(pathToFileURL(appRequire.resolve('@electron/asar')).href)
}
const args=process.argv.slice(2),report=path.resolve(root,args.find(value=>value.startsWith('--report='))?.slice(9)||'.runtime/final-windows-package-audit.json')
const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version
const target=path.resolve(root,args.find(value=>value.startsWith('--package-dir='))?.slice(14)||`release/${version}/win-unpacked`),archive=path.join(target,'resources/app.asar')
const relativeReport=path.relative(path.join(root,'.runtime'),report)
assert.ok(relativeReport&&!relativeReport.startsWith('..')&&!path.isAbsolute(relativeReport))
const hashFile=file=>{const digest=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(256*1024);try{let size;while((size=fs.readSync(fd,buffer,0,buffer.length,null)))digest.update(buffer.subarray(0,size))}finally{fs.closeSync(fd)}return digest.digest('hex')}
const hashBytes=value=>createHash('sha256').update(value).digest('hex')
const archived=asar.listPackage(archive).map(value=>value.replaceAll('\\','/').replace(/^\//,'')).sort()
function list(directory,prefix=''){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{const name=prefix+entry.name,file=path.join(directory,entry.name);assert.equal(entry.isSymbolicLink(),false,'Packaged tree contains a link');return entry.isDirectory()?list(file,name+'/'):[name]}).sort()}
const unpacked=list(target)
const forbidden=name=>{
  const value=name.toLowerCase(),parts=value.split('/'),base=parts.at(-1)
  if(parts.includes('.runtime')||parts.includes('.git'))return 'workspace-or-history'
  if(/^\.env(?:\.|$)/.test(base)||['.npmrc','.netrc','.git-credentials','.modules.yaml'].includes(base)||base.startsWith('.pnpm-workspace-state'))return 'environment-or-local-metadata'
  if(/\.(?:keystore|jks|p12|pfx|key)$/.test(base)||/^(?:id_rsa|id_ed25519)(?:\.|$)/.test(base)||/private.*\.(?:pem|der)$/.test(base))return 'private-key-material'
  if(/^(?:\.ai-novel|\.vela|profiles?|accounts?|user[-_]data)\//.test(value)
    ||/^(?:config|credentials|oauth-tokens|google-drive-state|token-store)\.json$/.test(value))return 'account-or-author-state'
  return null
}
const prohibited=[...archived.map(name=>({container:'asar',path:name,reason:forbidden(name)})),...unpacked.map(name=>({container:'directory',path:name,reason:forbidden(name)}))].filter(value=>value.reason)
const main=asar.extractFile(archive,'dist-electron/main.js'),renderer=asar.extractFile(archive,'dist/index.html')
assert.equal(hashBytes(main),hashFile(path.join(root,'dist-electron/main.js')),'Packaged main does not match the current built main')
assert.equal(hashBytes(renderer),hashFile(path.join(root,'dist/index.html')),'Packaged renderer does not match the current built renderer')
const result={checkedAt:new Date().toISOString(),target,archive,build:readBuildFingerprint(root),pathInventoryOnly:true,
  executable:{path:path.join(target,WINDOWS_EXECUTABLE_NAME),sha256:hashFile(path.join(target,WINDOWS_EXECUTABLE_NAME))},
  asarSha256:hashFile(archive),packagedMainSha256:hashBytes(main),packagedRendererSha256:hashBytes(renderer),
  inventories:{asarPaths:archived,directoryPaths:unpacked},prohibited,passed:prohibited.length===0}
fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n')
assert.equal(prohibited.length,0,'Packaged paths contain a prohibited private or workspace file; see path-only audit')
console.log(JSON.stringify({...result,inventories:{asarPaths:archived.length,directoryPaths:unpacked.length}}))
