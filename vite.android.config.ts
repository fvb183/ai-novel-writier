import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import fs from 'node:fs'
import { androidWebSourceFingerprint } from './scripts/android-web-source-fingerprint.mjs'
const root=path.resolve(import.meta.dirname)
const pkg=JSON.parse(fs.readFileSync(path.join(root,'android','release.json'),'utf8'))
let androidOutDir=path.join(root,'mobile-dist')
let sourceFingerprint=''
const shim=(file:string)=>path.join(root,'mobile/shims',file+'.ts')
export default defineConfig({
  cacheDir:path.join(root,'.runtime','vite-android-cache'),
  root:path.join(root,'mobile'),base:'./',publicDir:path.join(root,'public'),
  plugins:[tailwindcss(),react(),{name:'android-license',apply:'build',configResolved(config){androidOutDir=config.build.outDir;sourceFingerprint=androidWebSourceFingerprint(root)},writeBundle(){
    const dist=androidOutDir
    fs.copyFileSync(path.join(root,'LICENSE'),path.join(dist,'LICENSE.txt'))
    if(androidWebSourceFingerprint(root)!==sourceFingerprint)throw new Error('Android web sources changed during the build')
    fs.writeFileSync(path.join(dist,'android-web-source.json'),JSON.stringify({version:1,sourceSetSha256:sourceFingerprint})+'\n')
  }}],
  resolve:{alias:[
    {find:/^.*\/services\/google-drive-authorization$/,replacement:shim('google-drive-authorization')},
    {find:/^(node:)?fs\/promises$/,replacement:shim('fs-promises')},
    ...['fs','path','os','crypto','module','util'].map(name=>({find:new RegExp(`^(node:)?${name}$`),replacement:shim(name)})),
    {find:/^(node:)?child_process$/,replacement:shim('child-process')},
    {find:/^(node:)?stream$/,replacement:shim('stream')},
    {find:'electron',replacement:shim('electron')},
    {find:'better-sqlite3',replacement:shim('sqlite')},
    {find:'@lancedb/lancedb',replacement:shim('lancedb')},
    {find:'yauzl',replacement:shim('yauzl')},
    {find:/^.*\/security\/windows-safe-file-system$/,replacement:shim('secure-fs')},
  ]},
  define:{__APP_VERSION__:JSON.stringify(pkg.version)},
  build:{outDir:path.join(root,'mobile-dist'),emptyOutDir:true,target:'es2022',chunkSizeWarningLimit:1500},
  server:{host:'127.0.0.1',port:5190,strictPort:true,fs:{allow:[root]}}
})
