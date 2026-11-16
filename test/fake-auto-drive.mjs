import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const md5 = bytes => createHash('md5').update(bytes).digest('hex')
export class FakeAutomaticDrive {
  files=new Map(); next=0; offline=false; calls=0
  client(check=()=>{}) { const self=this; return new Proxy(this,{get(target,key){const member=target[key];if(typeof member!=='function')return member;return async(...args)=>{check();if(self.offline)throw new Error('DRIVE_NETWORK_FAILED');self.calls++;const result=await member.apply(target,args);check();return result}}}) }
  async accountId(){return 'synthetic-account'}
  async allocateId(){return 'synthetic_'+(++this.next)}
  async projects(){return [...this.files.values()].filter(x=>x.file.appProperties.ainwKind==='project').map(({file})=>({folderId:file.id,projectId:file.appProperties.ainwProject,name:file.name,autoSync:file.appProperties.ainwAutoSync!=='0'}))}
  async checkFolder(id,projectId){const value=this.files.get(id)?.file;if(!value)throw new Error('DRIVE_FILE_NOT_FOUND');if(projectId&&value.appProperties.ainwProject!==projectId)throw new Error('DRIVE_PROJECT_MISMATCH');return structuredClone(value)}
  async createProject(projectId,name,id,autoSync){this.files.set(id,{file:{id,name:'AI Novel Writer · '+name,mimeType:'application/vnd.google-apps.folder',appProperties:{ainwProject:projectId,ainwKind:'project',ainwApp:'ai-novel-writer-sync-v1',...(autoSync===false?{ainwAutoSync:'0'}:{})}}});return id}
  async setProjectAutoSync(id,projectId,enabled){await this.checkFolder(id,projectId);this.files.get(id).file.appProperties.ainwAutoSync=enabled?'1':'0'}
  async discover(folder,projectId){return {cursor:'cursor_'+this.files.size,files:[...this.files.values()].filter(x=>x.file.parents?.includes(folder)&&x.file.appProperties.ainwProject===projectId&&x.file.appProperties.ainwKind==='sync').map(x=>structuredClone(x.file))}}
  async download(file){const stored=this.files.get(file.id);if(!stored)throw new Error('DRIVE_FILE_NOT_FOUND');assert.equal(sha(stored.bytes),file.appProperties.ainwDigest);return stored.bytes.slice()}
  async deleteSyncFile(folder,projectId,expected){const stored=this.files.get(expected.id);if(!stored)return;const file=stored.file;assert.ok(file.parents.includes(folder));assert.equal(file.appProperties.ainwProject,projectId);assert.equal(file.appProperties.ainwKind,'sync');assert.equal(file.appProperties.ainwDigest,expected.appProperties.ainwDigest);this.files.delete(file.id)}
  put(folder,projectId,kind,bytes,upload){const old=this.files.get(upload.fileId);if(old){assert.equal(sha(old.bytes),upload.digest);return false}assert.equal(sha(bytes),upload.digest);this.files.set(upload.fileId,{bytes:Buffer.from(bytes),file:{id:upload.fileId,name:upload.digest,parents:[folder],size:String(bytes.length),md5Checksum:md5(bytes),appProperties:{ainwProject:projectId,ainwKind:kind,ainwApp:'ai-novel-writer-sync-v1',ainwDigest:upload.digest}}});return true}
  async publish(folder,projectId,bytes,upload){return this.put(folder,projectId,'sync',bytes,upload)}
  async listObjects(folder,projectId,kind){return [...this.files.values()].filter(x=>x.file.parents?.includes(folder)&&x.file.appProperties.ainwProject===projectId&&x.file.appProperties.ainwKind===kind).map(x=>structuredClone(x.file))}
  async publishObject(folder,projectId,kind,source,upload){const bytes=await source.read(0,source.byteSize);return this.put(folder,projectId,kind,bytes,upload)}
  async downloadObject(file,folder,projectId,kind,expected,write){const bytes=this.files.get(file.id).bytes;assert.equal(sha(bytes),expected.sha256);assert.equal(bytes.length,expected.byteSize);await write(bytes)}
}
