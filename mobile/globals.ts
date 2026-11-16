import {Buffer} from 'buffer'
const environment=JSON.parse((globalThis as any).AndroidBridge.sync(JSON.stringify({op:'env',args:[]})))
if(!environment.ok)throw new Error(environment.error)
const env=environment.value
Object.assign(globalThis,{Buffer,global:globalThis,process:{platform:'android',arch:'arm64',pid:1,version:'v22.0.0',versions:{node:'22.0.0'},env:{NODE_ENV:'production',HOME:env.filesDir},argv:[],cwd:()=>env.filesDir,nextTick:(fn:Function,...args:any[])=>queueMicrotask(()=>fn(...args)),stdout:{write:console.log},stderr:{write:console.error}},setImmediate:(fn:Function,...args:any[])=>setTimeout(()=>fn(...args),0),clearImmediate:clearTimeout})
Object.assign(globalThis,{__ANDROID_PROJECTS_PATH__:env.filesDir+'/Projects'})
document.documentElement.dataset.platform='android'
