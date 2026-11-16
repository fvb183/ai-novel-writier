/** Execute the production NativeBridge exclusive installer on a JVM. Only
 * Android OS/JSON boundaries are host shims; file moves, FileLock and bytes are
 * real. Os.link deliberately enforces the Android app hard-link prohibition. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'

const root=path.resolve(import.meta.dirname,'..')
const run=fs.mkdtempSync(path.join(root,'.runtime/sync-install-native-'))
const jdk=process.env.JAVA_HOME||path.join(root,'.runtime/android-toolchain/jdk17/jdk-17.0.20.1+1')
const sdk=process.env.ANDROID_HOME||path.join(root,'.runtime/android-toolchain/android-sdk')
const androidJar=path.join(sdk,'platforms/android-35/android.jar')
const existing=path.join(root,'android/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes')
const nativeSource=path.join(root,'android/java/io/github/ethanyoq/ainovelwriter/NativeBridge.java')
const native=path.join(run,'native'), host=path.join(run,'host'), source=path.join(run,'src')
for(const dir of [native,host,source])fs.mkdirSync(dir,{recursive:true})
const files={
  'org/json/JSONArray.java':`package org.json; public class JSONArray { final java.util.List<Object> values=new java.util.ArrayList<>(); public JSONArray put(Object v){values.add(v);return this;} public int length(){return values.size();} public Object get(int i){return values.get(i);} public String getString(int i){return String.valueOf(get(i));} }`,
  'android/system/ErrnoException.java':`package android.system; public class ErrnoException extends Exception {public final int errno;public ErrnoException(String op,int n){super(op+" errno="+n);errno=n;}}`,
  'android/system/StructTimespec.java':`package android.system; public class StructTimespec {public long tv_sec,tv_nsec; public StructTimespec(long s,long n){tv_sec=s;tv_nsec=n;}}`,
  'android/system/StructStat.java':`package android.system; public class StructStat {public long st_dev,st_ino,st_nlink,st_size,st_rdev,st_blksize=4096,st_blocks,st_ctime;public int st_mode,st_uid,st_gid;public StructTimespec st_atim,st_mtim,st_ctim;}`,
  'android/system/OsConstants.java':`package android.system; public class OsConstants {public static final int O_RDONLY=0,O_WRONLY=1,O_RDWR=2,O_NOFOLLOW=131072,ENOENT=2,EACCES=13,EPERM=1,EEXIST=17; public static boolean S_ISREG(int m){return (m&0170000)==0100000;}public static boolean S_ISDIR(int m){return (m&0170000)==0040000;}public static boolean S_ISLNK(int m){return (m&0170000)==0120000;}}`,
  'android/system/Os.java':String.raw`package android.system;
    import java.io.*;import java.nio.file.*;import java.nio.file.attribute.*;import java.util.*;
    public class Os {
      static class Handle {Path path;java.nio.channels.FileChannel file;StructStat admitted;Handle(Path p,java.nio.channels.FileChannel f,StructStat s){path=p;file=f;admitted=s;}}
      static final Map<FileDescriptor,Handle> handles=new IdentityHashMap<>();static final Map<Object,Long> inodes=new HashMap<>();static long next=100;public static int linkCalls,fsyncCalls;
      public static Path fixtureRoot;
      static Object identity(BasicFileAttributes a){if(a.fileKey()!=null)return a.fileKey();try{Class<?> type=a.getClass();StringBuilder out=new StringBuilder();for(String field:new String[]{"volSerialNumber","fileIndexHigh","fileIndexLow"}){java.lang.reflect.Method method=type.getDeclaredMethod(field);method.setAccessible(true);out.append(method.invoke(a)).append(':');}return out.toString();}catch(Exception e){throw new IllegalStateException("Host file identity unavailable",e);}}
      public static Object identity(Path p)throws IOException{return identity(Files.readAttributes(p,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS));}
      static StructStat inspect(String name,boolean nofollow)throws ErrnoException{
        try{Path p=Paths.get(name);BasicFileAttributes a=Files.readAttributes(p,BasicFileAttributes.class,nofollow?new LinkOption[]{LinkOption.NOFOLLOW_LINKS}:new LinkOption[0]);StructStat s=new StructStat();Object key=identity(a);s.st_dev=1;s.st_ino=inodes.computeIfAbsent(key,k->next++);s.st_mode=a.isSymbolicLink()?0120000:a.isDirectory()?0040000:0100000;s.st_nlink=1;s.st_size=a.size();
          if(a.isRegularFile()&&fixtureRoot!=null){try(java.util.stream.Stream<Path> all=Files.walk(fixtureRoot)){s.st_nlink=all.filter(f->{try{return Files.isRegularFile(f,LinkOption.NOFOLLOW_LINKS)&&Objects.equals(identity(f),key);}catch(IOException e){return false;}}).count();}}
          long ms=a.lastModifiedTime().toMillis();s.st_mtim=new StructTimespec(ms/1000,(ms%1000)*1000000);s.st_atim=s.st_ctim=s.st_mtim;return s;
        }catch(NoSuchFileException e){throw new ErrnoException("lstat",OsConstants.ENOENT);}catch(IOException e){throw new ErrnoException("lstat",OsConstants.EACCES);}
      }
      public static StructStat lstat(String p)throws ErrnoException{return inspect(p,true);}public static StructStat stat(String p)throws ErrnoException{return inspect(p,false);}
      public static FileDescriptor open(String p,int flags,int mode)throws ErrnoException{
        StructStat s=lstat(p);if(OsConstants.S_ISLNK(s.st_mode))throw new ErrnoException("open",OsConstants.EACCES);
        try{java.nio.channels.FileChannel f=OsConstants.S_ISDIR(s.st_mode)?null:java.nio.channels.FileChannel.open(Paths.get(p),(flags&3)==0?new StandardOpenOption[]{StandardOpenOption.READ}:new StandardOpenOption[]{StandardOpenOption.READ,StandardOpenOption.WRITE});FileDescriptor fd=new FileDescriptor();handles.put(fd,new Handle(Paths.get(p),f,s));return fd;}catch(IOException e){throw new ErrnoException("open",OsConstants.EACCES);}
      }
      public static StructStat fstat(FileDescriptor fd)throws ErrnoException{Handle h=handles.get(fd);if(h==null)throw new ErrnoException("fstat",9);return Files.exists(h.path,LinkOption.NOFOLLOW_LINKS)?lstat(h.path.toString()):h.admitted;}
      public static void close(FileDescriptor fd)throws ErrnoException{Handle h=handles.remove(fd);if(h==null)throw new ErrnoException("close",9);try{if(h.file!=null)h.file.close();}catch(IOException e){throw new ErrnoException("close",5);}}
      public static void fsync(FileDescriptor fd)throws ErrnoException{Handle h=handles.get(fd);if(h==null)throw new ErrnoException("fsync",9);fsyncCalls++;try{if(h.file!=null)h.file.force(true);}catch(IOException e){throw new ErrnoException("fsync",5);}}
      public static void link(String from,String to)throws ErrnoException{linkCalls++;throw new ErrnoException("link",OsConstants.EPERM);}
      public static int openHandles(){return handles.size();}
    }`,
  'io/github/ethanyoq/ainovelwriter/NativeSyncInstallHost.java':String.raw`package io.github.ethanyoq.ainovelwriter;
    import java.io.*;import java.lang.reflect.*;import java.nio.channels.*;import java.nio.file.*;import java.nio.file.attribute.*;import java.security.*;import java.util.*;import org.json.*;import android.system.*;
    public class NativeSyncInstallHost {
      static NativeBridge bridge;static Method install;static FileLock lock;static FileChannel channel;static Path files;static int checks;
      static void set(String name,Object value)throws Exception{Field f=NativeBridge.class.getDeclaredField(name);f.setAccessible(true);f.set(bridge,value);}
      static void check(boolean ok,String label){if(!ok)throw new AssertionError(label);checks++;System.out.println("PASS "+label);}
      static void invoke(Path from,Path to,boolean owned)throws Exception{try{if(owned){synchronized(bridge){install.invoke(bridge,new JSONArray().put(from.toString()).put(to.toString()));}}else install.invoke(bridge,new JSONArray().put(from.toString()).put(to.toString()));}catch(InvocationTargetException e){Throwable cause=e.getCause();if(cause instanceof Exception)throw (Exception)cause;throw e;}}
      static Path write(String name,String text)throws Exception{Path f=files.resolve(name);Files.createDirectories(f.getParent());Files.write(f,text.getBytes("UTF-8"));return f;}
      static boolean rejected(Path from,Path to)throws Exception{try{invoke(from,to,true);return false;}catch(Exception expected){return true;}}
      static String text(Path p)throws Exception{return new String(Files.readAllBytes(p),"UTF-8");}
      static Object key(Path p)throws Exception{return Os.identity(p);}
      public static void main(String[] args)throws Exception{
        Path base=Paths.get(args[0]);files=Files.createDirectories(base.resolve("files"));Path cache=Files.createDirectories(base.resolve("cache"));Os.fixtureRoot=base;
        Field u=sun.misc.Unsafe.class.getDeclaredField("theUnsafe");u.setAccessible(true);bridge=(NativeBridge)((sun.misc.Unsafe)u.get(null)).allocateInstance(NativeBridge.class);set("root",files.toFile().getCanonicalFile());set("cache",cache.toFile().getCanonicalFile());set("exportFiles",new HashMap<>());set("exportMirrors",new HashMap<>());
        channel=FileChannel.open(files.resolve(".runtime.lock"),StandardOpenOption.CREATE,StandardOpenOption.WRITE);lock=channel.tryLock();set("ownershipLock",lock);
        install=NativeBridge.class.getDeclaredMethod("installExclusiveFile",JSONArray.class);install.setAccessible(true);
        try{
          boolean denied=false;try{Os.link("not-called-by-installer","not-created");}catch(ErrnoException e){denied=e.errno==OsConstants.EPERM;}check(denied,"android-hard-links-denied-at-os-boundary");int oldLinks=Os.linkCalls;
          Path s=write("staging/source","中文知识原文🙂\n完整字节"),t=files.resolve("blobs/installed");Files.createDirectories(t.getParent());Object before=key(s);byte[] bytes=Files.readAllBytes(s);invoke(s,t,true);check(!Files.exists(s)&&Arrays.equals(bytes,Files.readAllBytes(t))&&Objects.equals(before,key(t)),"complete-atomic-move-preserves-bytes-and-inode");
          check(rejected(s,t)&&Arrays.equals(bytes,Files.readAllBytes(t)),"retry-with-missing-source-preserves-installed-target");
          s=write("staging/conflict","source-conflict");Path original=write("blobs/conflict","original-target");check(rejected(s,original)&&text(s).equals("source-conflict")&&text(original).equals("original-target"),"existing-file-never-overwritten");
          Path dir=Files.createDirectory(files.resolve("blobs/existing-dir"));check(rejected(s,dir)&&Files.isDirectory(dir)&&Files.exists(s),"existing-directory-never-overwritten");
          Path victim=write("victim","victim-sentinel"),targetLink=files.resolve("blobs/target-link");Files.createSymbolicLink(targetLink,victim);check(rejected(s,targetLink)&&Files.isSymbolicLink(targetLink)&&text(victim).equals("victim-sentinel")&&Files.exists(s),"existing-target-symlink-never-followed");
          Path sourceLink=files.resolve("staging/source-link");Files.createSymbolicLink(sourceLink,victim);Path absent=files.resolve("blobs/source-link-result");check(rejected(sourceLink,absent)&&Files.isSymbolicLink(sourceLink)&&!Files.exists(absent),"source-symlink-rejected");
          Path parentLink=files.resolve("alias");Files.createSymbolicLink(parentLink,files.resolve("blobs"));check(rejected(s,parentLink.resolve("escape"))&&Files.exists(s)&&!Files.exists(files.resolve("blobs/escape")),"symlink-parent-rejected");
          Path hard=files.resolve("staging/hard-link");Files.createLink(hard,s);check(rejected(s,files.resolve("blobs/hard"))&&Files.exists(s)&&Files.exists(hard),"source-extra-hard-link-rejected");Files.delete(hard);
          check(rejected(files.resolve("staging/missing"),files.resolve("blobs/missing"))&&!Files.exists(files.resolve("blobs/missing")),"missing-source-rejected");
          boolean outside=false;try{invoke(s,base.resolve("outside"),true);}catch(Exception expected){outside=true;}check(outside&&Files.exists(s)&&!Files.exists(base.resolve("outside")),"private-storage-boundary-enforced");
          boolean monitor=false;try{invoke(s,files.resolve("blobs/no-monitor"),false);}catch(Exception expected){monitor=true;}check(monitor&&Files.exists(s)&&!Files.exists(files.resolve("blobs/no-monitor")),"native-monitor-required");
          set("ownershipLock",null);check(rejected(s,files.resolve("blobs/no-lock"))&&Files.exists(s)&&!Files.exists(files.resolve("blobs/no-lock")),"runtime-lock-required");set("ownershipLock",lock);
          lock.release();check(rejected(s,files.resolve("blobs/stale-lock"))&&Files.exists(s)&&!Files.exists(files.resolve("blobs/stale-lock")),"released-runtime-lock-rejected");lock=channel.tryLock();set("ownershipLock",lock);
          byte[] large=new byte[1024*1024+17];new Random(7).nextBytes(large);Path largeSource=files.resolve("staging/large"),largeTarget=files.resolve("blobs/large");Files.write(largeSource,large);Object largeKey=key(largeSource);invoke(largeSource,largeTarget,true);check(Arrays.equals(large,Files.readAllBytes(largeTarget))&&Objects.equals(largeKey,key(largeTarget)),"multi-chunk-author-bytes-remain-complete");
          check(Os.linkCalls==oldLinks,"installer-never-invokes-hard-link");check(Os.fsyncCalls>=6,"file-and-directory-sync-attempted");check(Os.openHandles()==0,"all-native-file-descriptors-closed");System.out.println("CHECKS="+checks);
        }finally{if(lock!=null&&lock.isValid())lock.release();channel.close();}
      }
    }`,
}
for(const [relative,content] of Object.entries(files)){const file=path.join(source,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content)}
const execute=(name,args,log)=>{
  const result=spawnSync(path.join(jdk,'bin',name),args,{cwd:root,encoding:'utf8',windowsHide:true})
  fs.writeFileSync(path.join(run,log),(result.stdout||'')+(result.stderr||''))
  assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,`See ${path.join(run,log)}`);return result.stdout||''
}
let report
try{
  assert.ok(fs.existsSync(androidJar)&&fs.existsSync(existing),'Build native Android classes once before this contract test')
  execute('javac.exe',['-encoding','UTF-8','-source','8','-target','8','-cp',[androidJar,existing].join(path.delimiter),'-d',native,nativeSource],'native-javac.log')
  execute('javac.exe',['-encoding','UTF-8','-cp',[native,androidJar,existing].join(path.delimiter),'-d',host,...Object.keys(files).map(p=>path.join(source,p))],'host-javac.log')
  const output=execute('java.exe',['-Dsun.nio.fs.ensureAccurateMetadata=true','--add-opens=java.base/sun.nio.fs=ALL-UNNAMED','-cp',[host,native,existing,androidJar].join(path.delimiter),'io.github.ethanyoq.ainovelwriter.NativeSyncInstallHost',path.join(run,'fixture')],'contract.log')
  const checks=output.split(/\r?\n/).filter(line=>line.startsWith('PASS ')).map(line=>({name:line.slice(5),passed:true}))
  assert.equal(checks.length,18)
  report={passed:true,checks,actualProductionMethod:true,actualFileMoves:true,actualRuntimeFileLock:true,androidOsBoundaryStubbed:true,selinuxHardLinkDenied:true,directoryFsyncStubbed:true,deviceTest:false}
}catch(error){report={passed:false,error:String(error.stack||error),deviceTest:false};process.exitCode=1}
report.nativeSourceSha256=createHash('sha256').update(fs.readFileSync(nativeSource)).digest('hex');report.artifacts=run
fs.writeFileSync(path.join(root,'.runtime/r6-native-sync-install-report.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
