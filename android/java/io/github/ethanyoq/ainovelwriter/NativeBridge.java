package io.github.ethanyoq.ainovelwriter;

import android.app.*;
import android.content.*;
import android.database.Cursor;
import android.database.sqlite.*;
import android.graphics.*;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.system.*;
import android.util.Base64;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.channels.FileLock;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.*;
import javax.crypto.*;
import javax.crypto.spec.*;

/** Native storage/SQLite/crypto/HTTP adapter; never evaluates untrusted code. */
public final class NativeBridge {
    final MainActivity activity;
    final WebView web;
    final GoogleDriveAuthorization google;
    final DeviceSecureStorage secureStorage;
    final File root, cache;
    private RandomAccessFile ownershipFile;
    private FileLock ownershipLock;
    final ExecutorService pool = Executors.newCachedThreadPool();
    final Map<Integer, RandomAccessFile> handles = new HashMap<>();
    final Map<Integer, FileDescriptor> directoryHandles = new HashMap<>();
    final Map<Integer, File> handleFiles = new HashMap<>();
    final Map<String, SQLiteDatabase> databases = new HashMap<>();
    final Map<String, MessageDigest> digests = new HashMap<>();
    final Map<String, HttpURLConnection> requests = new ConcurrentHashMap<>();
    final Set<String> canceledRequests = ConcurrentHashMap.newKeySet();
    final Map<String, PendingWrite> pendingWrites = new HashMap<>();
    final Map<Integer, PendingDialog> dialogs = new HashMap<>();
    final Map<String, Uri> exportMirrors = new HashMap<>();
    final Map<String, Uri> exportFiles = new HashMap<>();
    int nextFd = 100, nextDialog = 200;
    static final int MAX_FILE = 256 * 1024 * 1024;
    static final int SECURE_FILE_LIMIT = 64 * 1024 * 1024;
    static class SecureFileException extends IOException { final String code; SecureFileException(String c,String message){super(message);code=c;} }
    static final SecureRandom RANDOM = new SecureRandom();
    static class PendingWrite { File root, parent, target, temp; String dev, ino, parentDev, parentIno; boolean mustExist; }
    static class PendingDialog { String id, kind; JSONObject options; File mirror; }
    NativeBridge(MainActivity a, WebView w) {
        activity=a; web=w; root=canonical(a.getFilesDir()); cache=canonical(a.getCacheDir());
        google=new GoogleDriveAuthorization(a,this);
        secureStorage=new DeviceSecureStorage(a.getPackageName());
        try {
            ownershipFile=new RandomAccessFile(new File(root,".runtime.lock"),"rw");
            ownershipLock=ownershipFile.getChannel().tryLock();
            if(ownershipLock==null)throw new IOException("应用数据已由另一个运行实例使用");
            new File(root,"Projects").mkdirs();
        }catch(Exception error){try{if(ownershipFile!=null)ownershipFile.close();}catch(IOException ignored){}throw new IllegalStateException("无法取得应用数据独占权限",error);}
    }

    private static File canonical(File f){try{return f.getCanonicalFile();}catch(IOException e){return f;}}
    @JavascriptInterface public synchronized String sync(String input) {
        try { JSONObject r=new JSONObject(input); return ok(call(r.getString("op"),r.optJSONArray("args"))).toString(); }
        catch(Throwable e) { return error(e).toString(); }
    }
    @JavascriptInterface public void request(String id, String input) {
        try {
            JSONObject r=new JSONObject(input); String op=r.getString("op"); JSONArray args=r.optJSONArray("args");
            if (op.startsWith("google.")) { activity.runOnUiThread(() -> google.request(id,op,args)); return; }
            if (op.equals("http.request")) { pool.execute(() -> http(id,args)); return; }
            if (op.startsWith("dialog.") || op.equals("file.open") || op.equals("file.save")) { activity.runOnUiThread(() -> dialog(id,op,args)); return; }
            pool.execute(() -> { try { Object v; synchronized(this) { v=call(op,args); } resolve(id,ok(v)); } catch(Throwable e) { resolve(id,error(e)); } });
        } catch(Throwable e) { resolve(id,error(e)); }
    }
    private static JSONObject ok(Object v) throws JSONException { return new JSONObject().put("ok",true).put("value",v==null?JSONObject.NULL:v); }
    private static JSONObject error(Throwable e) {
        JSONObject o=new JSONObject(); try { String code="EIO"; if(e instanceof SecureFileException)code=((SecureFileException)e).code; if(e instanceof DeviceSecureStorage.Failure)code=((DeviceSecureStorage.Failure)e).code; if(e instanceof FileNotFoundException)code="ENOENT"; if(e instanceof SecurityException)code="EACCES"; if(e instanceof FileAlreadyExistsException)code="EEXIST"; if(e instanceof ErrnoException)code=((ErrnoException)e).errno==OsConstants.ENOENT?"ENOENT":((ErrnoException)e).errno==OsConstants.EEXIST?"EEXIST":((ErrnoException)e).errno==OsConstants.EACCES?"EACCES":((ErrnoException)e).errno==OsConstants.EPERM?"EPERM":((ErrnoException)e).errno==OsConstants.ENOSPC?"ENOSPC":"EIO"; o.put("ok",false).put("error",e.getMessage()==null?e.toString():e.getMessage()).put("code",code); } catch(Exception ignored){} return o;
    }
    void resolve(String id,JSONObject value) { js("globalThis.__androidResolve&&globalThis.__androidResolve("+JSONObject.quote(id)+","+value+")"); }
    void event(String id,String name,Object data) { String value=data==null?"null":data instanceof String?JSONObject.quote((String)data):data.toString(); js("globalThis.__androidEvent&&globalThis.__androidEvent("+JSONObject.quote(id)+","+JSONObject.quote(name)+","+value+")"); }
    void js(String code) { activity.runOnUiThread(() -> { if(!activity.isFinishing())web.evaluateJavascript(code,null); }); }
    private static String b64(byte[] data) { return Base64.encodeToString(data,Base64.NO_WRAP); }
    private static byte[] bytes(Object data) { return data==null||data==JSONObject.NULL?new byte[0]:Base64.decode(String.valueOf(data),Base64.DEFAULT); }
    private File file(Object value) throws IOException {
        if(value instanceof Number) { File f=handleFiles.get(((Number)value).intValue()); if(f==null)throw new IOException("EBADF: 文件句柄已关闭"); return f; }
        String path=String.valueOf(value); File f=new File(path); if(!f.isAbsolute())f=new File(root,path);
        String actual=f.getCanonicalPath(); String r=root.getCanonicalPath(),c=cache.getCanonicalPath();
        if(!actual.equals(r)&&!actual.startsWith(r+File.separator)&&!actual.equals(c)&&!actual.startsWith(c+File.separator))throw new SecurityException("文件路径超出应用私有目录");
        return f;
    }
    /** The caller gains a validation result, never access to ancestor contents. */
    private void validateDirectoryChain(String value,boolean allowMissing) throws Exception {
        File target=file(value);
        if(!target.getAbsolutePath().equals(target.toPath().normalize().toString()))throw new SecurityException("目录路径含有非规范分段");
        File current=new File("/");
        boolean missing=false;
        for(String part:target.getAbsolutePath().substring(1).split("/")){
            if(part.isEmpty())continue;
            current=new File(current,part);
            if(missing)continue;
            try{
                StructStat st=Os.lstat(current.toString());
                if(!OsConstants.S_ISDIR(st.st_mode)||OsConstants.S_ISLNK(st.st_mode)
                    ||!current.getCanonicalPath().equals(current.getAbsolutePath()))throw new SecurityException("目录链包含链接或非目录");
            }catch(ErrnoException e){if(allowMissing&&e.errno==OsConstants.ENOENT)missing=true;else throw e;}
        }
    }

    /** The app's canonical private roots are trusted anchors. Do not require
     * stat permission on Android's /data ancestors to publish an owned file. */
    private void validateInstallParent(File parent)throws Exception {
        String value=parent.getAbsolutePath(),r=root.getAbsolutePath(),c=cache.getAbsolutePath();
        File anchor=value.equals(r)||value.startsWith(r+File.separator)?root:
            value.equals(c)||value.startsWith(c+File.separator)?cache:null;
        if(anchor==null||!value.equals(parent.toPath().normalize().toString())||!value.equals(parent.getCanonicalPath()))throw new SecurityException("安装目录超出私有目录或包含链接");
        for(File current=parent;;current=current.getParentFile()){
            StructStat info=Os.lstat(current.toString());
            if(!OsConstants.S_ISDIR(info.st_mode)||OsConstants.S_ISLNK(info.st_mode)||!current.getCanonicalPath().equals(current.getAbsolutePath()))throw new SecurityException("安装目录不是普通目录");
            if(current.equals(anchor))return;
            if(current.getParentFile()==null)throw new SecurityException("安装目录身份无效");
        }
    }
    private static boolean sameInstallIdentity(StructStat left,StructStat right){return left.st_dev==right.st_dev&&left.st_ino==right.st_ino;}
    private static void syncInstallDirectory(File parent)throws Exception {
        FileDescriptor descriptor=Os.open(parent.toString(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);
        try{Os.fsync(descriptor);}finally{Os.close(descriptor);}
    }
    /** Android SELinux forbids app hard links. Publication is a same-filesystem
     * atomic move serialized with every native fs call, under the app's retained
     * runtime lock. An existing target of any kind is never replaced. */
    private void installExclusiveFile(JSONArray args)throws Exception {
        if(!Thread.holdsLock(this)||ownershipLock==null||!ownershipLock.isValid())throw new SecurityException("安装文件需要应用私有目录独占权限");
        if(args.length()!=2||!(args.get(0) instanceof String)||!(args.get(1) instanceof String))throw new IllegalArgumentException("安装文件参数无效");
        File from=file(args.get(0)),to=file(args.get(1)),fromParent=from.getParentFile(),toParent=to.getParentFile();
        if(from.equals(to))throw new FileAlreadyExistsException(to.toString());
        validateInstallParent(fromParent);validateInstallParent(toParent);
        StructStat source=Os.lstat(from.toString()),sourceParent=Os.lstat(fromParent.toString()),targetParent=Os.lstat(toParent.toString());
        if(!OsConstants.S_ISREG(source.st_mode)||source.st_nlink!=1||!from.getCanonicalPath().equals(from.getAbsolutePath()))throw new SecurityException("安装来源必须是独占普通文件");
        FileDescriptor held=Os.open(from.toString(),OsConstants.O_RDWR|OsConstants.O_NOFOLLOW,0);
        try{
            StructStat opened=Os.fstat(held);
            if(!sameInstallIdentity(source,opened)||!OsConstants.S_ISREG(opened.st_mode)||opened.st_nlink!=1)throw new SecurityException("安装来源身份已变化");
            Os.fsync(held);
            validateInstallParent(fromParent);validateInstallParent(toParent);
            if(!sameInstallIdentity(sourceParent,Os.lstat(fromParent.toString()))||!sameInstallIdentity(targetParent,Os.lstat(toParent.toString()))||!sameInstallIdentity(source,Os.lstat(from.toString())))throw new SecurityException("安装目录或来源身份已变化");
            try{Os.lstat(to.toString());throw new FileAlreadyExistsException(to.toString());}catch(ErrnoException absent){if(absent.errno!=OsConstants.ENOENT)throw absent;}
            // Private-root exclusivity plus this monitor closes the destination
            // check/move race; no REPLACE_EXISTING or copy-to-final fallback.
            Files.move(from.toPath(),to.toPath(),StandardCopyOption.ATOMIC_MOVE);
            StructStat installed=Os.lstat(to.toString());
            if(!sameInstallIdentity(source,installed)||!OsConstants.S_ISREG(installed.st_mode)||installed.st_nlink!=1)throw new SecurityException("安装后的文件身份无效");
            syncInstallDirectory(toParent);if(!fromParent.equals(toParent))syncInstallDirectory(fromParent);
        }finally{Os.close(held);}
    }
    private String appVersion() throws Exception {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(),0).versionName;
    }
    private JSONObject stat(File f,boolean lstat) throws Exception {
        StructStat st=lstat?Os.lstat(f.getAbsolutePath()):Os.stat(f.getAbsolutePath());return statResult(st);
    }
    private JSONObject statResult(StructStat st)throws Exception {
        return new JSONObject().put("size",st.st_size).put("mtimeMs",st.st_mtim.tv_sec*1000.0+st.st_mtim.tv_nsec/1000000.0).put("atimeMs",st.st_atim.tv_sec*1000.0+st.st_atim.tv_nsec/1000000.0).put("ctimeMs",st.st_ctim.tv_sec*1000.0+st.st_ctim.tv_nsec/1000000.0).put("birthtimeMs",st.st_ctime*1000L).put("nlink",st.st_nlink).put("uid",st.st_uid).put("gid",st.st_gid).put("rdev",Long.toUnsignedString(st.st_rdev)).put("blksize",st.st_blksize).put("blocks",st.st_blocks).put("mode",st.st_mode).put("dev",Long.toUnsignedString(st.st_dev)).put("ino",Long.toUnsignedString(st.st_ino)).put("isFile",OsConstants.S_ISREG(st.st_mode)).put("isDirectory",OsConstants.S_ISDIR(st.st_mode)).put("isSymbolicLink",OsConstants.S_ISLNK(st.st_mode));
    }
    private byte[] read(InputStream input,long limit) throws IOException { try(InputStream in=input; ByteArrayOutputStream out=new ByteArrayOutputStream()) { byte[] b=new byte[32768]; int n; long count=0; while((n=in.read(b))!=-1){count+=n;if(count>limit)throw new IOException("文件超出允许大小");out.write(b,0,n);}return out.toByteArray();} }
    private byte[] readFile(Object arg) throws Exception {
        if(arg instanceof Number){RandomAccessFile h=handles.get(((Number)arg).intValue());if(h==null)throw new IOException("EBADF");long len=h.length();if(len>MAX_FILE)throw new IOException("文件过大");h.seek(0);byte[] b=new byte[(int)len];h.readFully(b);return b;}
        File f=file(arg);if(f.length()>MAX_FILE)throw new IOException("文件过大");return read(new FileInputStream(f),MAX_FILE);
    }
    private void remove(File f,boolean recursive,boolean force) throws IOException {
        if(!f.exists()){if(!force)throw new FileNotFoundException(f.toString());return;}
        if(f.getCanonicalFile().equals(root)||f.getCanonicalFile().equals(cache))throw new SecurityException("不能删除应用根目录");
        try{if(OsConstants.S_ISLNK(Os.lstat(f.toString()).st_mode)){if(!f.delete())throw new IOException("无法删除链接");return;}}catch(ErrnoException e){throw new IOException(e);}
        if(f.isDirectory()){File[] list=f.listFiles();if(list!=null&&list.length>0&&!recursive)throw new IOException("ENOTEMPTY");if(list!=null)for(File child:list)remove(child,true,force);}
        if(!f.delete())throw new IOException("无法删除 "+f.getName());
    }
    private Object call(String op,JSONArray a) throws Exception {
        if(a==null)a=new JSONArray();
        switch(op) {
            case "secureStorage.available": return secureStorage.available();
            case "secureStorage.encrypt": {if(a.length()!=1||!(a.get(0) instanceof String))throw new DeviceSecureStorage.Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID");return secureStorage.encrypt(a.getString(0));}
            case "secureStorage.decrypt": {if(a.length()!=1||!(a.get(0) instanceof String))throw new DeviceSecureStorage.Failure("ANDROID_SECURE_STORAGE_INPUT_INVALID");return secureStorage.decrypt(a.getString(0));}
            case "env": return new JSONObject().put("filesDir",root.getAbsolutePath()).put("cacheDir",cache.getAbsolutePath()).put("version",appVersion()).put("platform","android");
            case "fs.validateDirectoryChain": {validateDirectoryChain(a.getString(0),a.optJSONObject(1)!=null&&a.getJSONObject(1).optBoolean("allowMissing"));return null;}
            case "fs.chmod": {File f=file(a.get(0));if(OsConstants.S_ISLNK(Os.lstat(f.toString()).st_mode))throw new SecurityException("不允许修改链接权限");Os.chmod(f.toString(),a.getInt(1)&0777);return null;}
            case "fs.link": {File from=file(a.get(0)),to=file(a.get(1));validateDirectoryChain(from.getParent(),false);validateDirectoryChain(to.getParent(),false);if(!OsConstants.S_ISREG(Os.lstat(from.toString()).st_mode))throw new SecurityException("链接来源不是普通文件");Os.link(from.toString(),to.toString());mirror(to);return null;}
            case "fs.installExclusive": {installExclusiveFile(a);mirror(file(a.get(1)));return null;}
            case "fs.copyFile": {File from=file(a.get(0)),to=file(a.get(1));if(a.optInt(2)==1)Files.copy(from.toPath(),to.toPath());else Files.copy(from.toPath(),to.toPath(),StandardCopyOption.REPLACE_EXISTING);mirror(to);return null;}
            case "fs.exists": return file(a.get(0)).exists();
            case "fs.realpath": {File f=file(a.get(0));if(!f.exists())throw new FileNotFoundException(f.toString());return f.getCanonicalPath();}
            case "fs.stat": {if(a.get(0) instanceof Number){FileDescriptor dir=directoryHandles.get(a.getInt(0));if(dir!=null)return statResult(Os.fstat(dir));RandomAccessFile h=handles.get(a.getInt(0));if(h==null)throw new IOException("EBADF");return statResult(Os.fstat(h.getFD()));}return stat(file(a.get(0)),a.optJSONObject(1)!=null&&a.getJSONObject(1).optBoolean("lstat"));}
            case "fs.readFile": return b64(readFile(a.get(0)));
            case "fs.readdir": {File f=file(a.get(0));File[] list=f.listFiles();if(list==null)throw new FileNotFoundException(f.toString());JSONArray out=new JSONArray();for(File child:list){JSONObject st=stat(child,true);out.put(new JSONObject().put("name",child.getName()).put("isFile",st.getBoolean("isFile")).put("isDirectory",st.getBoolean("isDirectory")).put("isSymbolicLink",st.getBoolean("isSymbolicLink")));}return out;}
            case "fs.mkdir": {File f=file(a.get(0));JSONObject opts=a.optJSONObject(1);boolean recursive=opts!=null&&opts.optBoolean("recursive");if(f.exists()){if(recursive&&f.isDirectory())return null;throw new FileAlreadyExistsException(f.toString());}if(!(recursive?f.mkdirs():f.mkdir()))throw new IOException("无法创建目录 "+f);Os.chmod(f.toString(),opts==null?0700:opts.optInt("mode",0700)&0777);return null;}
            case "fs.rename": {File from=file(a.get(0)),to=file(a.get(1));Files.move(from.toPath(),to.toPath(),StandardCopyOption.REPLACE_EXISTING);mirror(to);return null;}
            case "fs.remove": {JSONObject opts=a.optJSONObject(1);File target=file(a.get(0));if(opts!=null&&opts.optBoolean("fileOnly")&&target.isDirectory())throw new IOException("EISDIR: 不能用 unlink 删除目录");if(opts!=null&&opts.optBoolean("directoryOnly")&&target.exists()&&!target.isDirectory())throw new IOException("ENOTDIR: 不是目录");remove(target,opts!=null&&opts.optBoolean("recursive"),opts!=null&&opts.optBoolean("force"));return null;}
            case "fs.writeFile": {Object target=a.get(0);byte[] data=bytes(a.get(1));JSONObject opts=a.optJSONObject(2);String flag=opts==null?"w":opts.optString("flag","w");File f=file(target);if(target instanceof Number){RandomAccessFile h=handles.get(((Number)target).intValue());if(h==null)throw new IOException("EBADF");h.write(data);}else {if(flag.contains("x")&&!f.createNewFile())throw new FileAlreadyExistsException(f.toString());try(FileOutputStream out=new FileOutputStream(f,flag.startsWith("a"))){out.write(data);out.getFD().sync();}}mirror(f);return null;}
            case "fs.open": {File f=file(a.get(0));String flag=a.optString(1,"r");if(a.opt(1) instanceof Number){int flags=a.getInt(1);flag=(flags&1024)!=0?"a":(flags&512)!=0?"w":(flags&3)==0?"r":"r+";if((flags&128)!=0)flag+="x";}int fd=nextFd++;if(f.isDirectory()){if(!flag.equals("r"))throw new IOException("EISDIR");FileDescriptor directory=Os.open(f.toString(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);if(!OsConstants.S_ISDIR(Os.fstat(directory).st_mode)){Os.close(directory);throw new IOException("ENOTDIR");}directoryHandles.put(fd,directory);handleFiles.put(fd,f);return fd;}boolean existed=f.exists();if(flag.contains("x")&&!f.createNewFile())throw new FileAlreadyExistsException(f.toString());if((flag.equals("r")||flag.equals("r+"))&&!f.exists())throw new FileNotFoundException(f.toString());RandomAccessFile h=new RandomAccessFile(f,flag.equals("r")?"r":"rw");try{if(!existed)Os.fchmod(h.getFD(),a.optInt(2,0600)&0777);if(flag.startsWith("w"))h.setLength(0);if(flag.startsWith("a"))h.seek(h.length());handles.put(fd,h);handleFiles.put(fd,f);return fd;}catch(Exception e){h.close();throw e;}}
            case "fs.close": {int fd=a.getInt(0);RandomAccessFile h=handles.remove(fd);FileDescriptor dir=directoryHandles.remove(fd);File f=handleFiles.remove(fd);if(h!=null)h.close();if(dir!=null)Os.close(dir);if(f!=null)mirror(f);return null;}
            case "fs.fsync": {FileDescriptor dir=directoryHandles.get(a.getInt(0));if(dir!=null){Os.fsync(dir);return null;}RandomAccessFile h=handles.get(a.getInt(0));if(h==null)throw new IOException("EBADF");h.getFD().sync();return null;}
            case "fs.write": {RandomAccessFile h=handles.get(a.getInt(0));if(h==null)throw new IOException("EBADF");if(!a.isNull(2))h.seek(a.getLong(2));byte[] data=bytes(a.get(1));h.write(data);return data.length;}
            case "fs.read": {RandomAccessFile h=handles.get(a.getInt(0));if(h==null)throw new IOException("EBADF");int length=a.getInt(2);if(length<0||length>MAX_FILE)throw new IOException("无效读取大小");if(!a.isNull(3))h.seek(a.getLong(3));byte[] b=new byte[length];int n=h.read(b);return b64(n<0?new byte[0]:Arrays.copyOf(b,n));}
            case "fs.securePrepare": return securePrepare(a.getJSONObject(0));
            case "fs.secureCommit": {PendingWrite w=pendingWrites.remove(a.getString(0));if(w==null)throw new IOException("写入令牌无效或已使用");try{checkIdentity(w.root,w.dev,w.ino);checkIdentity(w.parent,w.parentDev,w.parentIno);checkSegments(w.root,w.target);if(w.mustExist&&!w.target.isFile())throw new SecureFileException("SECURE_FS_NOT_FOUND","目标文件不存在");Files.move(w.temp.toPath(),w.target.toPath(),StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);mirror(w.target);}finally{w.temp.delete();}return null;}
            case "fs.secureCancel": {PendingWrite w=pendingWrites.remove(a.getString(0));if(w!=null)w.temp.delete();return null;}
            case "fs.secureRead": {JSONObject opts=a.getJSONObject(0);File r=file(opts.getString("rootPath")),f=new File(r,opts.getString("relativePath").replace('\\','/'));file(f.toString());checkRootIdentity(r,opts.optJSONObject("rootIdentity"));checkSegments(r,f);long max=opts.optLong("maxBytes",SECURE_FILE_LIMIT);if(max<0||max>SECURE_FILE_LIMIT)throw new SecureFileException("SECURE_FS_FILE_TOO_LARGE","安全读取上限无效");if(!f.isFile())throw new SecureFileException("SECURE_FS_NOT_FOUND","目标文件不存在");if(f.length()>max)throw new SecureFileException("SECURE_FS_FILE_TOO_LARGE","文件超出允许大小");FileDescriptor fd=Os.open(f.getAbsolutePath(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);try{return b64(read(new FileInputStream(fd),max));}catch(IOException e){if(e.getMessage()!=null&&e.getMessage().contains("大小"))throw new SecureFileException("SECURE_FS_FILE_TOO_LARGE",e.getMessage());throw e;}finally{try{Os.close(fd);}catch(ErrnoException ignored){}}}
            case "sqlite.open": {String id=UUID.randomUUID().toString();boolean memory=(a.getString(0).equals(":memory:")||a.getString(0).isEmpty());File f=memory?null:file(a.getString(0));JSONObject opts=a.optJSONObject(1);boolean ro=opts!=null&&opts.optBoolean("readonly");if(!memory&&opts!=null&&opts.optBoolean("fileMustExist")&&!f.exists())throw new FileNotFoundException(f.toString());SQLiteDatabase db=memory?SQLiteDatabase.create(null):SQLiteDatabase.openDatabase(f.toString(),null,ro?SQLiteDatabase.OPEN_READONLY:SQLiteDatabase.CREATE_IF_NECESSARY|SQLiteDatabase.OPEN_READWRITE);try{try(Cursor timeoutCursor=db.rawQuery("PRAGMA busy_timeout="+(opts==null?5000:opts.optInt("timeout",5000)),null)){timeoutCursor.moveToFirst();}databases.put(id,db);return id;}catch(Throwable error){try{db.close();}catch(Throwable ignored){}throw error;}}
            case "sqlite.openVerified": return openVerifiedDatabase(a);
            case "sqlite.close": {SQLiteDatabase db=databases.remove(a.getString(0));if(db!=null)db.close();return null;}
            case "sqlite.backup": return backupDatabase(db(a.getString(0)),file(a.getString(1)));
            case "sqlite.serialize": {File snapshot=consistentSnapshot(db(a.getString(0)));try{return b64(read(new FileInputStream(snapshot),MAX_FILE));}finally{snapshot.delete();}}
            case "sqlite.exec": {SQLiteDatabase db=db(a.getString(0));validateSql(a.getString(1));for(String sql:splitSql(a.getString(1))){if(configureForeignKeys(db,sql,null))continue;if(sql.trim().matches("(?is)^ROLLBACK\\s+TO\\b.*"))sql=";"+sql;db.execSQL(sql);}return null;}
            case "sqlite.query": {validateSql(a.getString(1));return query(db(a.getString(0)),a.getString(1),a.optJSONArray(2));}
            case "sqlite.schemaSnapshot": {
                SQLiteDatabase database=db(a.getString(0));
                JSONArray objects=query(database,"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name='android_metadata' OR tbl_name='android_metadata'",null);
                return new JSONObject().put("schema",query(database,"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",null))
                    .put("objects",objects).put("columns",objects.length()==0?new JSONArray():query(database,"PRAGMA table_info(android_metadata)",null))
                    .put("rows",objects.length()==0?new JSONArray():query(database,"SELECT locale FROM android_metadata",null));
            }
            case "sqlite.run": {SQLiteDatabase db=db(a.getString(0));String sql=a.getString(1);validateSql(sql);boolean ownTransaction=!db.inTransaction();if(ownTransaction)db.beginTransactionNonExclusive();try{SQLiteStatement st=db.compileStatement(sql);int changes;try{bind(st,a.optJSONArray(2));changes=st.executeUpdateDelete();}finally{st.close();}JSONArray rows=query(db,"SELECT last_insert_rowid() AS lastInsertRowid",new JSONArray());Object rowid=rows.getJSONObject(0).get("lastInsertRowid");if(rowid instanceof JSONObject)rowid=((JSONObject)rowid).getString("$int64");JSONObject out=new JSONObject().put("changes",changes).put("lastInsertRowid",rowid);if(ownTransaction)db.setTransactionSuccessful();return out;}finally{if(ownTransaction)db.endTransaction();}}
            case "crypto.random": {int n=a.getInt(0);if(n<0||n>MAX_FILE)throw new IOException("无效随机数长度");byte[] out=new byte[n];RANDOM.nextBytes(out);return b64(out);}
            case "crypto.hash": {MessageDigest md=MessageDigest.getInstance(a.getString(0).replace("sha256","SHA-256").replace("sha512","SHA-512"));return b64(md.digest(bytes(a.get(1))));}
            case "crypto.hash.create": {String id=UUID.randomUUID().toString();digests.put(id,MessageDigest.getInstance(a.getString(0).replace("sha256","SHA-256").replace("sha512","SHA-512")));return id;}
            case "crypto.hash.update": {MessageDigest digest=digests.get(a.getString(0));if(digest==null)throw new IOException("哈希句柄已关闭");digest.update(bytes(a.get(1)));return null;}
            case "crypto.hash.digest": {MessageDigest digest=digests.remove(a.getString(0));if(digest==null)throw new IOException("哈希句柄已关闭");return b64(digest.digest());}
            case "crypto.hash.copy": {MessageDigest digest=digests.get(a.getString(0));if(digest==null)throw new IOException("哈希句柄已关闭");String id=UUID.randomUUID().toString();digests.put(id,(MessageDigest)digest.clone());return id;}
            case "crypto.hmac": {String algorithm="Hmac"+a.getString(0).replace("-","").toUpperCase(Locale.ROOT);Mac mac=Mac.getInstance(algorithm);mac.init(new SecretKeySpec(bytes(a.get(1)),algorithm));return b64(mac.doFinal(bytes(a.get(2))));}
            case "crypto.cipher": case "crypto.decipher": {if(!a.getString(0).equalsIgnoreCase("aes-256-gcm"))throw new GeneralSecurityException("不支持的加密算法");boolean enc=op.equals("crypto.cipher");Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(enc?Cipher.ENCRYPT_MODE:Cipher.DECRYPT_MODE,new SecretKeySpec(bytes(a.get(1)),"AES"),new GCMParameterSpec(128,bytes(a.get(2))));int aadIndex=enc?4:5;if(a.length()>aadIndex&&!a.isNull(aadIndex))cipher.updateAAD(bytes(a.get(aadIndex)));byte[] data=bytes(a.get(3));if(!enc){byte[] tag=bytes(a.get(4));byte[] joined=Arrays.copyOf(data,data.length+tag.length);System.arraycopy(tag,0,joined,data.length,tag.length);return b64(cipher.doFinal(joined));}byte[] out=cipher.doFinal(data);return new JSONObject().put("data",b64(Arrays.copyOf(out,out.length-16))).put("tag",b64(Arrays.copyOfRange(out,out.length-16,out.length)));}
            case "http.cancel": {String id=a.getString(0);canceledRequests.add(id);HttpURLConnection conn=requests.remove(id);if(conn!=null)pool.execute(conn::disconnect);return null;}
            case "image.inspect": {BitmapFactory.Options o=new BitmapFactory.Options();o.inJustDecodeBounds=true;byte[] data=bytes(a.get(0));BitmapFactory.decodeByteArray(data,0,data.length,o);return new JSONObject().put("width",Math.max(0,o.outWidth)).put("height",Math.max(0,o.outHeight));}
            case "image.convert": {byte[] data=bytes(a.get(0));Bitmap image=BitmapFactory.decodeByteArray(data,0,data.length);if(image==null)throw new IOException("图片无法解码");int width=a.optInt(3,image.getWidth()),height=a.optInt(4,image.getHeight());if(width>0&&height>0&&(width!=image.getWidth()||height!=image.getHeight())){Bitmap resized=Bitmap.createScaledBitmap(image,width,height,true);if(resized!=image)image.recycle();image=resized;}String format=a.optString(1,"png");Bitmap.CompressFormat fmt=format.equalsIgnoreCase("jpeg")||format.equalsIgnoreCase("jpg")?Bitmap.CompressFormat.JPEG:format.equalsIgnoreCase("webp")?Bitmap.CompressFormat.WEBP:Bitmap.CompressFormat.PNG;ByteArrayOutputStream out=new ByteArrayOutputStream();image.compress(fmt,a.optInt(2,90),out);image.recycle();return b64(out.toByteArray());}
            case "shell.open": case "shell.openExternal": { final String url=a.optString(0);activity.runOnUiThread(()->activity.openExternal(url));return null;}
            case "shell.openPath": return "文件保存在应用内；请使用导出功能保存到系统目录";
            case "app.background": activity.runOnUiThread(()->activity.moveTaskToBack(true));return null;
            case "app.close": case "app.exit": activity.runOnUiThread(()->activity.finish());return null;
            default: throw new UnsupportedOperationException("未实现的原生操作: "+op);
        }
    }
    private static String aString(JSONArray a,int i){return a.optString(i);}
    private SQLiteDatabase db(String id) throws IOException {SQLiteDatabase db=databases.get(id);if(db==null)throw new IOException("数据库连接已关闭");return db;}
    private static final String EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    private static SecureFileException changedSqliteSource(){return new SecureFileException("SOURCE_CHANGED_SINCE_PROBE","作品数据库在校验后发生变化");}
    private static boolean sameSqliteFile(StructStat first,StructStat next){
        return OsConstants.S_ISREG(next.st_mode)&&next.st_nlink==1&&first.st_dev==next.st_dev&&first.st_ino==next.st_ino
            &&first.st_size==next.st_size&&first.st_mtim.tv_sec==next.st_mtim.tv_sec&&first.st_mtim.tv_nsec==next.st_mtim.tv_nsec
            &&first.st_ctim.tv_sec==next.st_ctim.tv_sec&&first.st_ctim.tv_nsec==next.st_ctim.tv_nsec;
    }
    /** Retained NOFOLLOW descriptors bind the streamed hashes to the named files.
     * The bridge monitor and app ownership lock exclude other app operations until
     * SQLite has completed its own locale/journal configuration. */
    private static final class VerifiedSqliteFile {
        final File file; final FileDescriptor descriptor; final StructStat identity;
        VerifiedSqliteFile(File value)throws Exception{
            file=value;StructStat named=Os.lstat(file.toString());
            if(!OsConstants.S_ISREG(named.st_mode)||named.st_nlink!=1)throw new SecurityException("作品数据库及旁文件必须是独占普通文件");
            FileDescriptor opened=Os.open(file.toString(),OsConstants.O_RDONLY|OsConstants.O_NOFOLLOW,0);
            try{StructStat actual=Os.fstat(opened);if(!sameSqliteFile(named,actual))throw changedSqliteSource();descriptor=opened;identity=actual;}
            catch(Exception error){try{Os.close(opened);}catch(ErrnoException ignored){}throw error;}
        }
        String sha256()throws Exception{
            MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] chunk=new byte[65536];int count;
            while((count=Os.read(descriptor,chunk,0,chunk.length))>0)digest.update(chunk,0,count);
            StringBuilder result=new StringBuilder(64);for(byte value:digest.digest())result.append(String.format(Locale.ROOT,"%02x",value&255));
            return result.toString();
        }
        void unchanged()throws Exception{
            StructStat named;try{named=Os.lstat(file.toString());}catch(ErrnoException error){if(error.errno==OsConstants.ENOENT)throw changedSqliteSource();throw error;}
            if(!sameSqliteFile(identity,Os.fstat(descriptor))||!sameSqliteFile(identity,named))throw changedSqliteSource();
        }
        void close()throws ErrnoException{Os.close(descriptor);}
    }
    private String openVerifiedDatabase(JSONArray args)throws Exception{
        JSONObject options=args.optJSONObject(1),expected=args.optJSONObject(2);
        if(args.length()!=3||!(args.opt(0) instanceof String)||options==null||!Boolean.TRUE.equals(options.opt("fileMustExist"))
            ||options.optBoolean("readonly")||expected==null||expected.length()!=2
            ||!(expected.opt("database") instanceof String)||!expected.getString("database").matches("[a-f0-9]{64}")
            ||!(expected.opt("wal") instanceof String)||!expected.getString("wal").matches("[a-f0-9]{64}")
            ||args.getString(0).isEmpty()||args.getString(0).equals(":memory:"))
            throw new SecureFileException("SQLITE_VERIFIED_OPEN_INVALID","校验开库参数无效");
        if(ownershipLock==null||!ownershipLock.isValid())throw new SecureFileException("SQLITE_STORAGE_NOT_OWNED","未持有应用数据独占权限");
        File source=file(args.getString(0));validateDirectoryChain(source.getParent(),false);
        List<VerifiedSqliteFile> held=new ArrayList<>();List<File> absent=new ArrayList<>();SQLiteDatabase opened=null;
        try{
            VerifiedSqliteFile main=new VerifiedSqliteFile(source);held.add(main);VerifiedSqliteFile wal=null;
            for(String suffix:new String[]{"-wal","-shm","-journal"}){
                File sidecar=new File(source.toString()+suffix);
                try{VerifiedSqliteFile checked=new VerifiedSqliteFile(sidecar);held.add(checked);if(suffix.equals("-wal"))wal=checked;}
                catch(ErrnoException error){if(error.errno!=OsConstants.ENOENT)throw error;absent.add(sidecar);}
            }
            String databaseHash=main.sha256(),walHash=wal==null?EMPTY_SHA256:wal.sha256();
            if(!databaseHash.equals(expected.getString("database"))||!walHash.equals(expected.getString("wal")))throw changedSqliteSource();
            validateDirectoryChain(source.getParent(),false);
            for(VerifiedSqliteFile checked:held)checked.unchanged();
            for(File missing:absent){try{Os.lstat(missing.toString());throw changedSqliteSource();}catch(ErrnoException error){if(error.errno!=OsConstants.ENOENT)throw error;}}
            // A raw descriptor closed after SQLite opens the same inode can drop
            // this process's SQLite POSIX locks. Release every verifier descriptor
            // first, still inside the bridge monitor and app ownership boundary.
            while(!held.isEmpty()){int last=held.size()-1;held.get(last).close();held.remove(last);}
            // No SQLite handle or SQL exists before all byte and file checks pass.
            opened=SQLiteDatabase.openDatabase(source.toString(),null,SQLiteDatabase.OPEN_READWRITE);
            try(Cursor timeout=opened.rawQuery("PRAGMA busy_timeout="+options.optInt("timeout",5000),null)){timeout.moveToFirst();}
            String id=UUID.randomUUID().toString();databases.put(id,opened);opened=null;return id;
        }finally{
            if(opened!=null)try{opened.close();}catch(Throwable ignored){}
            for(VerifiedSqliteFile checked:held)try{checked.close();}catch(ErrnoException ignored){}
        }
    }
    /** Path-bearing SQL must use dedicated operations with the same private
     * directory checks as the filesystem bridge. Author text is always bound. */
    private static void validateSql(String sql){
        if(sql.matches("(?is).*\\b(ATTACH|DETACH|load_extension|writable_schema|temp_store_directory|data_store_directory)\\b.*")
            ||sql.matches("(?is).*\\bVACUUM\\b.*\\bINTO\\b.*"))throw new SecurityException("不允许通过 SQL 绕过应用存储边界");
    }
    /** VACUUM INTO reads one SQLite snapshot, including committed WAL pages.
     * Unsupported SQLite engines fail explicitly; checkpoint + file copy is never a fallback. */
    private File consistentSnapshot(SQLiteDatabase source) throws Exception {
        if(source.inTransaction())throw new IOException("数据库事务尚未结束，无法创建一致快照");
        File snapshot=new File(cache,"sqlite-snapshot-"+UUID.randomUUID()+".db");
        try {
            source.execSQL("VACUUM main INTO '"+snapshot.toString().replace("'","''")+"'");
            try(SQLiteDatabase verified=SQLiteDatabase.openDatabase(snapshot.toString(),null,SQLiteDatabase.OPEN_READONLY);
                Cursor check=verified.rawQuery("PRAGMA integrity_check",null)){
                if(!check.moveToFirst()||!"ok".equals(check.getString(0))||check.moveToNext())throw new IOException("数据库快照完整性验证失败");
                verifySnapshotRows(source,verified);
            }
            try(RandomAccessFile durable=new RandomAccessFile(snapshot,"rw")){durable.getFD().sync();}
            return snapshot;
        }catch(Exception error){snapshot.delete();throw new IOException("SQLITE_SNAPSHOT_FAILED: "+(error.getMessage()==null?error.getClass().getSimpleName():error.getMessage()),error);}
    }
    private static String sqlIdentifier(String name){return "\""+name.replace("\"","\"\"")+"\"";}
    /** VACUUM may renumber implicit rowids. Reject any such snapshot instead of
     * claiming equivalence to SQLite's online backup API or changing identities. */
    private void verifySnapshotRows(SQLiteDatabase source,SQLiteDatabase snapshot)throws Exception {
        String schema="SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
        compareQuery(source,snapshot,schema);
        compareQuery(source,snapshot,"PRAGMA user_version");
        compareQuery(source,snapshot,"PRAGMA application_id");
        try(Cursor tables=source.rawQuery("SELECT name,sql FROM sqlite_master WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name",null)){
            while(tables.moveToNext()){
                String name=tables.getString(0),definition=tables.getString(1);
                ArrayList<String> columns=new ArrayList<>();
                try(Cursor fields=source.rawQuery("PRAGMA table_info("+sqlIdentifier(name)+")",null)){
                    while(fields.moveToNext())columns.add(fields.getString(1));
                }
                String hidden=null;
                if(definition==null||!definition.toUpperCase(Locale.ROOT).matches("(?s).*\\bWITHOUT\\s+ROWID\\b.*")){
                    for(String candidate:new String[]{"_rowid_","rowid","oid"}){
                        boolean named=false;for(String column:columns)if(column.equalsIgnoreCase(candidate))named=true;
                        if(!named){hidden=candidate;break;}
                    }
                }
                String order;
                if(hidden!=null)order=sqlIdentifier(hidden);
                else {ArrayList<String> ordered=new ArrayList<>();for(String column:columns)ordered.add(sqlIdentifier(column));order=join(ordered,",");}
                if(order.isEmpty())throw new IOException("快照表没有可验证的列");
                compareQuery(source,snapshot,"SELECT "+(hidden==null?"":sqlIdentifier(hidden)+",")+"* FROM "+sqlIdentifier(name)+" ORDER BY "+order);
            }
        }
    }
    private void compareQuery(SQLiteDatabase source,SQLiteDatabase snapshot,String query)throws Exception {
        try(Cursor original=source.rawQuery(query,null);Cursor copied=snapshot.rawQuery(query,null)){
            if(original.getColumnCount()!=copied.getColumnCount())throw new IOException("快照列不一致");
            while(true){
                boolean left=original.moveToNext(),right=copied.moveToNext();
                if(left!=right)throw new IOException("快照行数不一致");
                if(!left)return;
                for(int column=0;column<original.getColumnCount();column++){
                    int type=original.getType(column);
                    if(type!=copied.getType(column))throw new IOException("快照值类型不一致");
                    boolean same;
                    switch(type){
                        case Cursor.FIELD_TYPE_NULL:same=true;break;
                        case Cursor.FIELD_TYPE_INTEGER:same=original.getLong(column)==copied.getLong(column);break;
                        case Cursor.FIELD_TYPE_FLOAT:same=Double.doubleToLongBits(original.getDouble(column))==Double.doubleToLongBits(copied.getDouble(column));break;
                        case Cursor.FIELD_TYPE_BLOB:same=Arrays.equals(original.getBlob(column),copied.getBlob(column));break;
                        default:same=original.getString(column).equals(copied.getString(column));
                    }
                    if(!same)throw new IOException("SQLITE_SNAPSHOT_ROW_CHANGED: 快照内容或隐藏行身份发生变化");
                }
            }
        }
    }
    private JSONObject backupDatabase(SQLiteDatabase source,File target) throws Exception {
        validateDirectoryChain(target.getParent(),false);
        if(!source.getPath().equals(":memory:")&&canonical(new File(source.getPath())).equals(canonical(target)))throw new SecurityException("备份不能覆盖源数据库");
        File snapshot=consistentSnapshot(source);
        boolean created=false;
        try{
            if(target.exists()){
                StructStat st=Os.lstat(target.toString());
                if(!OsConstants.S_ISREG(st.st_mode)||st.st_nlink!=1||st.st_size!=0)throw new SecurityException("备份目标必须是独占空文件");
            }else{if(!target.createNewFile())throw new FileAlreadyExistsException(target.toString());created=true;}
            FileDescriptor descriptor=Os.open(target.toString(),OsConstants.O_WRONLY|OsConstants.O_NOFOLLOW,0600);
            try(FileOutputStream out=new FileOutputStream(descriptor);InputStream in=new FileInputStream(snapshot)){
                StructStat opened=Os.fstat(descriptor),named=Os.lstat(target.toString());
                if(opened.st_ino!=named.st_ino||opened.st_dev!=named.st_dev||opened.st_nlink!=1||opened.st_size!=0)throw new SecurityException("备份目标身份已变化");
                byte[] chunk=new byte[65536];int count;while((count=in.read(chunk))!=-1)out.write(chunk,0,count);
                out.getFD().sync();
            }
            long pages;try(SQLiteDatabase verified=SQLiteDatabase.openDatabase(snapshot.toString(),null,SQLiteDatabase.OPEN_READONLY);Cursor count=verified.rawQuery("PRAGMA page_count",null)){count.moveToFirst();pages=count.getLong(0);}
            return new JSONObject().put("totalPages",pages).put("remainingPages",0);
        }catch(Exception error){if(created)target.delete();throw error;}
        finally{snapshot.delete();}
    }
    private static void bind(SQLiteProgram st,JSONArray params) throws Exception {if(params==null)return;for(int i=0;i<params.length();i++){Object v=params.get(i);int n=i+1;if(v==JSONObject.NULL)st.bindNull(n);else if(v instanceof JSONObject&&((JSONObject)v).has("$blob"))st.bindBlob(n,bytes(((JSONObject)v).get("$blob")));else if(v instanceof JSONObject&&((JSONObject)v).has("$int64"))st.bindLong(n,Long.parseLong(((JSONObject)v).getString("$int64")));else if(v instanceof Float||v instanceof Double)st.bindDouble(n,((Number)v).doubleValue());else if(v instanceof Number)st.bindLong(n,((Number)v).longValue());else if(v instanceof Boolean)st.bindLong(n,(Boolean)v?1:0);else st.bindString(n,String.valueOf(v));}}
    /** Keep Android's pool configuration in sync with connection-scoped SQLite PRAGMAs.
     * Inside a transaction SQLite intentionally treats this assignment as a no-op;
     * let SQLite execute it there rather than changing the pool or claiming success.
     */
    static boolean configureForeignKeys(SQLiteDatabase db,String sql,JSONArray params) throws Exception {
        if(params!=null&&params.length()!=0)return false;
        java.util.regex.Matcher match=java.util.regex.Pattern.compile("(?is)^\\s*PRAGMA\\s+(?:main\\s*\\.\\s*)?foreign_keys\\s*=\\s*(ON|OFF|TRUE|FALSE|YES|NO|0|1)\\s*;?\\s*$").matcher(sql);
        if(!match.matches()||db.inTransaction())return false;
        String value=match.group(1).toUpperCase(Locale.ROOT);
        boolean enabled=value.equals("ON")||value.equals("TRUE")||value.equals("YES")||value.equals("1");
        if(db.isReadOnly())db.execPerConnectionSQL("PRAGMA foreign_keys="+(enabled?"1":"0"),null);
        else db.setForeignKeyConstraintsEnabled(enabled);
        try(Cursor check=db.rawQuery("PRAGMA foreign_keys",null)){
            if(!check.moveToFirst()||check.getLong(0)!=(enabled?1:0))throw new IOException("SQLITE_FOREIGN_KEYS_CONFIGURATION_FAILED");
        }
        return true;
    }
    private JSONArray query(SQLiteDatabase db,String sql,JSONArray params) throws Exception {
        if(configureForeignKeys(db,sql,params))return new JSONArray();
        final Exception[] bindError={null};
        Cursor c=db.rawQueryWithFactory((database,driver,editTable,q)->{try{bind(q,params);}catch(Exception e){bindError[0]=e;}return new SQLiteCursor(driver,editTable,q);},sql,new String[0],null);
        try{if(bindError[0]!=null)throw bindError[0];JSONArray rows=new JSONArray();String[] names=c.getColumnNames();while(c.moveToNext()){JSONObject row=new JSONObject();for(int i=0;i<names.length;i++){Object v;switch(c.getType(i)){case Cursor.FIELD_TYPE_NULL:v=JSONObject.NULL;break;case Cursor.FIELD_TYPE_INTEGER:long integer=c.getLong(i);v=integer>9007199254740991L||integer< -9007199254740991L?new JSONObject().put("$int64",Long.toString(integer)):integer;break;case Cursor.FIELD_TYPE_FLOAT:v=c.getDouble(i);break;case Cursor.FIELD_TYPE_BLOB:v=new JSONObject().put("$blob",b64(c.getBlob(i)));break;default:v=c.getString(i);}row.put(names[i],v);}rows.put(row);}return rows;}finally{c.close();}
    }
    /** Lexical SQL splitter, including quotes, comments and CREATE TRIGGER bodies. */
    static List<String> splitSql(String input) {
        ArrayList<String> out=new ArrayList<>();StringBuilder part=new StringBuilder(),word=new StringBuilder();char quote=0;boolean line=false,block=false,trigger=false;int begin=0,cases=0;StringBuilder words=new StringBuilder();
        for(int i=0;i<input.length();i++){char c=input.charAt(i),next=i+1<input.length()?input.charAt(i+1):0;part.append(c);
            if(line){if(c=='\n')line=false;continue;}if(block){if(c=='*'&&next=='/'){part.append(next);i++;block=false;}continue;}
            if(quote!=0){if(c==quote){if(next==quote){part.append(next);i++;}else quote=0;}continue;}
            if(c=='-'&&next=='-'){part.append(next);i++;line=true;continue;}if(c=='/'&&next=='*'){part.append(next);i++;block=true;continue;}
            if(c=='\''||c=='"'||c=='`'){quote=c;continue;}if(c=='['){quote=']';continue;}
            if(Character.isLetterOrDigit(c)||c=='_'){word.append(Character.toUpperCase(c));continue;}
            if(word.length()>0){String w=word.toString();words.append(' ').append(w);if(words.toString().matches("(?s).*\\bCREATE\\s+(TEMP\\s+|TEMPORARY\\s+)?TRIGGER\\b.*"))trigger=true;if(trigger&&w.equals("BEGIN"))begin++;if(trigger&&w.equals("CASE"))cases++;if(trigger&&w.equals("END")){if(cases>0)cases--;else if(begin>0)begin--;}word.setLength(0);}
            if(c==';'&&(!trigger||begin==0)){String sql=part.toString().trim();if(!sql.isEmpty())out.add(sql);part.setLength(0);words.setLength(0);trigger=false;cases=0;}
        }
        String rest=part.toString().trim();if(!rest.replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)--[^\\n]*", "").trim().isEmpty())out.add(rest);return out;
    }
    private void checkIdentity(File f,String dev,String ino)throws Exception {StructStat st=Os.lstat(f.toString());if(OsConstants.S_ISLNK(st.st_mode)||!Long.toUnsignedString(st.st_dev).equals(dev)||!Long.toUnsignedString(st.st_ino).equals(ino))throw new SecureFileException("SECURE_FS_INVALID_PATH","文件目录身份已变化");}
    private void checkRootIdentity(File f,JSONObject identity)throws Exception {if(identity==null)throw new SecureFileException("SECURE_FS_INVALID_PATH","缺少目录身份");String dev=identity.optString("dev",identity.optString("volumeSerialNumber")),ino=identity.optString("ino",identity.optString("fileIndex"));if(!dev.matches("[0-9]+")||!ino.matches("[0-9]+"))throw new SecureFileException("SECURE_FS_INVALID_PATH","目录身份无效");checkIdentity(f,dev,ino);}
    private void checkSegments(File r,File f)throws Exception {String rootPath=r.getAbsolutePath();String target=f.getAbsolutePath();if(!target.startsWith(rootPath+"/")||target.contains("/../")||target.endsWith("/.."))throw new SecureFileException("SECURE_FS_INVALID_PATH","无效相对路径");File cur=r;for(String p:target.substring(rootPath.length()+1).split("/")){if(p.isEmpty()||p.equals(".")||p.equals(".."))throw new SecureFileException("SECURE_FS_INVALID_PATH","无效路径分段");cur=new File(cur,p);try{if(OsConstants.S_ISLNK(Os.lstat(cur.toString()).st_mode))throw new SecureFileException("SECURE_FS_INVALID_PATH","不允许符号链接");}catch(ErrnoException e){if(e.errno!=OsConstants.ENOENT)throw e;}}}
    private JSONObject securePrepare(JSONObject o)throws Exception {File r=file(o.getString("rootPath")),target=new File(r,o.getString("relativePath").replace('\\','/'));file(target.toString());checkRootIdentity(r,o.optJSONObject("rootIdentity"));checkSegments(r,target);boolean must=o.optBoolean("mustAlreadyExist");if(must&&!target.isFile())throw new SecureFileException("SECURE_FS_NOT_FOUND","目标文件不存在");if(target.isDirectory())throw new SecureFileException("SECURE_FS_INVALID_PATH","目标不能是目录");byte[] content=bytes(o.get("contentBase64"));if(content.length>SECURE_FILE_LIMIT)throw new SecureFileException("SECURE_FS_FILE_TOO_LARGE","写入文件超过 64 MB");PendingWrite w=new PendingWrite();w.root=r;w.target=target;w.parent=target.getParentFile();w.mustExist=must;StructStat rs=Os.lstat(r.toString()),ps=Os.lstat(w.parent.toString());w.dev=Long.toUnsignedString(rs.st_dev);w.ino=Long.toUnsignedString(rs.st_ino);w.parentDev=Long.toUnsignedString(ps.st_dev);w.parentIno=Long.toUnsignedString(ps.st_ino);w.temp=File.createTempFile(".vela-",".tmp",w.parent);try(FileOutputStream stream=new FileOutputStream(w.temp)){stream.write(content);stream.getFD().sync();}String token=UUID.randomUUID().toString();pendingWrites.put(token,w);return new JSONObject().put("token",token);}
    private void http(String id,JSONArray args) {
        HttpURLConnection conn=null;
        try {
            activity.runOnUiThread(()->{activity.getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);try{activity.startForegroundService(new Intent(activity,GenerationService.class));}catch(Exception ignored){}});
            String target=args.getString(0);JSONObject options=args.optJSONObject(1);if(options==null)options=new JSONObject();
            String redirectMode=options.optString("redirect","error");
            if(!redirectMode.equals("manual")&&!redirectMode.equals("error")&&!redirectMode.equals("follow"))throw new SecurityException("无效重定向模式");
            String method=options.optString("method","GET").toUpperCase(Locale.ROOT);byte[] body=options.isNull("body")?null:bytes(options.opt("body"));
            // Socket timeout measures inactivity, so an active model stream can
            // run longer than this. Drive supplies its remaining total budget.
            int timeout=options.optInt("timeoutMs",180_000);if(timeout<=0||timeout>600_000)throw new SecurityException("无效网络超时");int redirects=0;
            while(true){
                if(canceledRequests.contains(id))throw new IOException("请求已取消");URL url=new URL(target);String scheme=url.getProtocol();if(!scheme.equals("http")&&!scheme.equals("https"))throw new SecurityException("只允许 HTTP/HTTPS 模型请求");if(url.getUserInfo()!=null)throw new SecurityException("URL 不允许包含用户凭证");
                String proxyUrl=options.optString("proxy","");Proxy proxy=parseProxy(proxyUrl);conn=(HttpURLConnection)(proxy==null?url.openConnection():url.openConnection(proxy));requests.put(id,conn);conn.setInstanceFollowRedirects(false);conn.setRequestMethod(method);conn.setConnectTimeout(Math.min(timeout,30000));conn.setReadTimeout(timeout);conn.setRequestProperty("Accept-Encoding","identity");
                if(canceledRequests.contains(id))throw new IOException("请求已取消");
                JSONObject headers=options.optJSONObject("headers");if(headers!=null)for(Iterator<String> it=headers.keys();it.hasNext();){String k=it.next(),v=headers.getString(k);if(k.indexOf('\n')>=0||k.indexOf('\r')>=0||v.indexOf('\n')>=0||v.indexOf('\r')>=0)throw new SecurityException("无效请求头");conn.setRequestProperty(k,v);}
                if(body!=null&&!method.equals("GET")&&!method.equals("HEAD")){conn.setDoOutput(true);conn.setFixedLengthStreamingMode(body.length);try(OutputStream out=conn.getOutputStream()){for(int offset=0;offset<body.length;offset+=16384){if(canceledRequests.contains(id))throw new IOException("请求已取消");out.write(body,offset,Math.min(16384,body.length-offset));}}}
                int status=conn.getResponseCode();
                if(status>=300&&status<=399&&conn.getHeaderField("Location")!=null&&!redirectMode.equals("manual")){
                    if(redirectMode.equals("error"))throw new IOException("服务器返回重定向；请在设置中填写最终 API 地址");
                    if(++redirects>5)throw new IOException("重定向次数过多");URL next=new URL(url,conn.getHeaderField("Location"));
                    if(!url.getHost().equalsIgnoreCase(next.getHost())||url.getPort()!=next.getPort()||!url.getProtocol().equals(next.getProtocol())){if(headers!=null){headers.remove("Authorization");headers.remove("authorization");headers.remove("x-api-key");headers.remove("X-Api-Key");}}
                    target=next.toString();if(status==303||(status==301||status==302)&&method.equals("POST")){method="GET";body=null;}conn.disconnect();continue;
                }
                JSONObject outHeaders=new JSONObject();for(Map.Entry<String,List<String>> h:conn.getHeaderFields().entrySet())if(h.getKey()!=null)outHeaders.put(h.getKey().toLowerCase(Locale.ROOT),join(h.getValue(),", "));
                event(id,"headers",new JSONObject().put("status",status).put("statusText",conn.getResponseMessage()==null?"":conn.getResponseMessage()).put("headers",outHeaders).put("url",target));
                InputStream stream=status>=400?conn.getErrorStream():conn.getInputStream();if(stream!=null)try(InputStream in=stream){byte[] b=new byte[16384];int n;while((n=in.read(b))!=-1){if(canceledRequests.contains(id))throw new IOException("请求已取消");event(id,"data",b64(Arrays.copyOf(b,n)));}}
                event(id,"end",null);break;
            }
        }catch(Throwable e){try{event(id,"error",new JSONObject().put("message",e.getMessage()==null?e.toString():e.getMessage()).put("code",canceledRequests.contains(id)?"NETWORK_ABORTED":e instanceof java.net.SocketTimeoutException?"NETWORK_TIMEOUT":"NETWORK_ERROR"));}catch(Exception ignored){}}
        finally{if(conn!=null)conn.disconnect();requests.remove(id);canceledRequests.remove(id);if(requests.isEmpty())activity.runOnUiThread(()->{activity.getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);activity.stopService(new Intent(activity,GenerationService.class));});}
    }
    private Proxy parseProxy(String value)throws Exception {
        if(value==null||value.trim().isEmpty())return null;
        URI uri=new URI(value.trim());String scheme=uri.getScheme()==null?"":uri.getScheme().toLowerCase(Locale.ROOT);
        if(!scheme.equals("http")&&!scheme.equals("socks")&&!scheme.equals("socks5")&&!scheme.equals("socks5h"))throw new IOException("安卓代理支持 http:// 或 socks5:// 地址");
        if(uri.getHost()==null||uri.getHost().isEmpty()||uri.getPort()<1||uri.getPort()>65535)throw new IOException("代理地址需要有效的主机和端口");
        if(uri.getUserInfo()!=null)throw new IOException("此安卓版本暂不支持带用户名密码的代理，请使用系统 VPN 或不需要认证的本地代理");
        return new Proxy(scheme.equals("http")?Proxy.Type.HTTP:Proxy.Type.SOCKS,InetSocketAddress.createUnresolved(uri.getHost(),uri.getPort()));
    }
    private static String join(List<String> values,String sep){StringBuilder out=new StringBuilder();for(String v:values){if(out.length()>0)out.append(sep);out.append(v);}return out.toString();}

    private void dialog(String id,String op,JSONArray args) {
        try {
            JSONObject options=args==null?new JSONObject():args.optJSONObject(0);if(options==null)options=new JSONObject();
            if(op.equals("dialog.message")) { messageDialog(id,options);return; }
            if(op.equals("dialog.error")){new AlertDialog.Builder(activity).setTitle(options.optString("title","提示")).setMessage(options.optString("content",options.optString("message"))).setPositiveButton("确定",(d,n)->resolveQuiet(id,0)).setOnCancelListener(d->resolveQuiet(id,0)).show();return;}
            boolean save=op.equals("dialog.save")||op.equals("file.save");
            JSONArray props=options.optJSONArray("properties");boolean directory=props!=null&&props.toString().contains("openDirectory");
            String title=options.optString("title",save?"保存文件":"选择文件");
            if(directory&&options.optString("purpose").equals("sync-project-location")){projectLocationDialog(id,options);return;}
            if(directory&&(title.contains("项目保存位置")||title.contains("恢复副本所在文件夹")||title.toLowerCase(Locale.ROOT).contains("project location"))) { projectLocationDialog(id,options);return; }
            PendingDialog p=new PendingDialog();p.id=id;p.options=options;
            Intent intent;
            if(directory){
                p.kind=title.contains("导出")||title.toLowerCase(Locale.ROOT).contains("export")?"export-directory":"import-directory";
                intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION|Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            } else if(save) {
                p.kind="save-file";intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);String suggested=new File(options.optString("defaultPath","novel.txt")).getName();intent.putExtra(Intent.EXTRA_TITLE,suggested);intent.setType(MainActivity.mime(suggested));intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } else {
                p.kind="import-file";intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("*/*");intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,props!=null&&props.toString().contains("multiSelections"));intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                JSONArray filters=options.optJSONArray("filters");ArrayList<String> mimes=new ArrayList<>();if(filters!=null)for(int n=0;n<filters.length();n++){JSONArray exts=filters.getJSONObject(n).optJSONArray("extensions");if(exts!=null)for(int i=0;i<exts.length();i++){String ext=exts.getString(i);String m=MainActivity.mime("x."+ext);if(!m.equals("application/octet-stream")&&!mimes.contains(m))mimes.add(m);}}if(!mimes.isEmpty())intent.putExtra(Intent.EXTRA_MIME_TYPES,mimes.toArray(new String[0]));
            }
            int code=nextDialog++;dialogs.put(code,p);activity.startActivityForResult(intent,code);
        } catch(Throwable e){resolve(id,error(e));}
    }
    private void messageDialog(String id,JSONObject opts)throws Exception {JSONArray buttons=opts.optJSONArray("buttons");String[] labels=buttons==null?new String[]{"确定"}:new String[buttons.length()];if(buttons!=null)for(int i=0;i<labels.length;i++)labels[i]=buttons.getString(i);AlertDialog.Builder b=new AlertDialog.Builder(activity).setTitle(opts.optString("title","Vela")).setMessage(opts.optString("message")+(opts.optString("detail").isEmpty()?"":"\n\n"+opts.optString("detail")));if(labels.length>0)b.setPositiveButton(labels[0],(d,n)->messageResult(id,0));if(labels.length>1)b.setNegativeButton(labels[1],(d,n)->messageResult(id,1));if(labels.length>2)b.setNeutralButton(labels[2],(d,n)->messageResult(id,2));b.setOnCancelListener(d->messageResult(id,opts.optInt("cancelId",labels.length>1?1:0))).show();}
    private void messageResult(String id,int response){try{resolveQuiet(id,new JSONObject().put("response",response).put("checkboxChecked",false));}catch(Exception ignored){}}
    private void resolveQuiet(String id,Object value){try{resolve(id,ok(value));}catch(Exception e){resolve(id,error(e));}}
    void onActivityResult(int code,int result,Intent data){
        if(google.onActivityResult(code,result,data))return;
        PendingDialog p=dialogs.remove(code);if(p==null)return;
        if(result!=Activity.RESULT_OK||data==null){try{resolveQuiet(p.id,new JSONObject().put("canceled",true).put("filePaths",new JSONArray()));}catch(Exception e){resolve(p.id,error(e));}return;}
        pool.execute(()->{try{
            JSONArray paths=new JSONArray();Uri uri=data.getData();
            if(p.kind.equals("export-directory")){activity.getContentResolver().takePersistableUriPermission(uri,data.getFlags()&(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION));File mirror=new File(root,"exports/"+UUID.randomUUID()+"/"+safeName(documentName(uri),"Export"));mirror.mkdirs();synchronized(this){exportMirrors.put(mirror.getCanonicalPath(),uri);}paths.put(mirror.toString());}
            else if(p.kind.equals("save-file")){File dest=new File(root,"exports/"+UUID.randomUUID()+"/"+safeName(displayName(uri),"novel.txt"));dest.getParentFile().mkdirs();synchronized(this){exportFiles.put(dest.getCanonicalPath(),uri);}resolveQuiet(p.id,new JSONObject().put("canceled",false).put("filePath",dest.toString()));return;}
            else if(p.kind.equals("import-directory")){File dir=new File(root,"imports/"+UUID.randomUUID()+"/"+safeName(documentName(uri),"Imported"));dir.mkdirs();Uri doc=DocumentsContract.buildDocumentUriUsingTree(uri,DocumentsContract.getTreeDocumentId(uri));copyTree(uri,doc,dir,new long[]{0},0,new int[]{0});paths.put(dir.toString());}
            else {ArrayList<Uri> selected=new ArrayList<>();if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)selected.add(data.getClipData().getItemAt(i).getUri());else if(uri!=null)selected.add(uri);long limit=p.options.optString("purpose").equals("sync-package-read")?64L*1024*1024:512L*1024*1024;File dir=new File(root,"imports/"+UUID.randomUUID());dir.mkdirs();for(Uri item:selected){File f=new File(dir,safeName(displayName(item),"imported.txt"));if(f.exists())throw new IOException("所选文件包含重复名称，请分批导入");try(InputStream in=activity.getContentResolver().openInputStream(item);FileOutputStream out=new FileOutputStream(f)){copy(in,out,new long[]{0},limit);}catch(Exception e){f.delete();throw e;}paths.put(f.toString());}}
            resolveQuiet(p.id,new JSONObject().put("canceled",false).put("filePaths",paths));
        }catch(Throwable e){resolve(p.id,error(e));}});
    }
    private static String safeName(String name,String fallback){if(name==null||name.isEmpty()||name.equals(".")||name.equals(".."))return fallback;return name.replace('/','_').replace('\\','_').replace('\0','_');}
    private String displayName(Uri uri){try(Cursor c=activity.getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst())return c.getString(0);}catch(Exception ignored){}return "imported.txt";}
    private String documentName(Uri uri){return displayName(DocumentsContract.buildDocumentUriUsingTree(uri,DocumentsContract.getTreeDocumentId(uri)));}
    private void copy(InputStream in,OutputStream out,long[] total)throws IOException {copy(in,out,total,512L*1024*1024);}
    private void copy(InputStream in,OutputStream out,long[] total,long limit)throws IOException {byte[] b=new byte[32768];int n;while((n=in.read(b))!=-1){total[0]+=n;if(total[0]>limit)throw new IOException("所选文件超过大小限制（"+(limit/1024/1024)+" MiB）");out.write(b,0,n);}}
    private void copyTree(Uri tree,Uri document,File dir,long[] total,int depth,int[] count)throws Exception {if(depth>128)throw new IOException("导入目录层级过深");Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getDocumentId(document));try(Cursor c=activity.getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE},null,null,null)){if(c==null)return;while(c.moveToNext()){if(++count[0]>20000)throw new IOException("导入文件数量过多");Uri child=DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0));File dest=new File(dir,safeName(c.getString(1),"import"));if(dest.exists())throw new IOException("导入目录含有重复文件名："+dest.getName());if(c.getString(2).equals(DocumentsContract.Document.MIME_TYPE_DIR)){dest.mkdirs();copyTree(tree,child,dest,total,depth+1,count);}else try(InputStream in=activity.getContentResolver().openInputStream(child);FileOutputStream out=new FileOutputStream(dest)){copy(in,out,total);}}}}
    private Uri child(Uri tree,Uri parent,String name,boolean directory)throws Exception {Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getDocumentId(parent));try(Cursor c=activity.getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c!=null)while(c.moveToNext())if(name.equals(c.getString(1)))return DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0));}return DocumentsContract.createDocument(activity.getContentResolver(),parent,directory?DocumentsContract.Document.MIME_TYPE_DIR:MainActivity.mime(name),name);}
    private void mirror(File f)throws Exception {if(!f.isFile()||f.getName().startsWith(".vela-")||f.getName().endsWith(".tmp"))return;String path=f.getCanonicalPath();Uri destination=exportFiles.get(path);if(destination==null)for(Map.Entry<String,Uri> item:exportMirrors.entrySet())if(path.startsWith(item.getKey()+"/")){Uri tree=item.getValue(),parent=DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree));String[] parts=path.substring(item.getKey().length()+1).split("/");for(int i=0;i<parts.length;i++)parent=child(tree,parent,parts[i],i<parts.length-1);destination=parent;break;}if(destination!=null)try(InputStream in=new FileInputStream(f);OutputStream out=activity.getContentResolver().openOutputStream(destination,"wt")){copy(in,out,new long[]{0});}}
    private void projectLocationDialog(String id,JSONObject options)throws Exception {
        if(options.optString("purpose").equals("sync-project-location")){
            File location=new File(root,"Projects");if(!location.isDirectory()&&!location.mkdirs())throw new IOException("无法创建项目目录");
            new AlertDialog.Builder(activity).setTitle("加入同步副本").setMessage("新副本将保存在应用内 Projects 目录；同步包含项目知识原文、提示词、技能和头像。检索索引在本机重建，模型 API 配置可在云同步页单独传递。").setPositiveButton("继续",(d,n)->{try{resolveQuiet(id,new JSONObject().put("canceled",false).put("filePaths",new JSONArray().put(location.toString())));}catch(Exception e){resolve(id,error(e));}}).setNegativeButton("取消",(d,n)->cancelDialog(id)).setOnCancelListener(d->cancelDialog(id)).show();return;
        }
        File projects=new File(root,"Projects");projects.mkdirs();ArrayList<File> found=new ArrayList<>();File[] children=projects.listFiles();if(children!=null)for(File f:children)if(f.isDirectory()&&(new File(f,".ai-novel/project.db").isFile()||new File(f,".vela/project.json").isFile()))found.add(f);Collections.sort(found,(l,r)->l.getName().compareToIgnoreCase(r.getName()));
        ArrayList<String> labels=new ArrayList<>();labels.add("新建项目：使用应用内 Projects 目录");for(File f:found)labels.add("打开："+f.getName());labels.add("从系统文件夹导入项目…");
        new AlertDialog.Builder(activity).setTitle("选择项目位置").setItems(labels.toArray(new String[0]),(d,index)->{try{if(index==labels.size()-1){JSONObject nested=new JSONObject(options.toString()).put("title","导入项目文件夹");nested.remove("purpose");dialog(id,"dialog.open",new JSONArray().put(nested));return;}File chosen=index==0?projects:found.get(index-1);resolveQuiet(id,new JSONObject().put("canceled",false).put("filePaths",new JSONArray().put(chosen.toString())));}catch(Exception e){resolve(id,error(e));}}).setNegativeButton("取消",(d,n)->cancelDialog(id)).setOnCancelListener(d->cancelDialog(id)).show();
    }
    private void cancelDialog(String id){try{resolveQuiet(id,new JSONObject().put("canceled",true).put("filePaths",new JSONArray()));}catch(Exception e){resolve(id,error(e));}}
    synchronized void destroy(){google.destroy();for(PendingWrite write:pendingWrites.values())write.temp.delete();pendingWrites.clear();for(HttpURLConnection c:requests.values())c.disconnect();requests.clear();for(SQLiteDatabase d:databases.values())try{d.close();}catch(Exception ignored){}databases.clear();for(RandomAccessFile f:handles.values())try{f.close();}catch(Exception ignored){}handles.clear();for(FileDescriptor descriptor:directoryHandles.values())try{Os.close(descriptor);}catch(Exception ignored){}directoryHandles.clear();handleFiles.clear();digests.clear();pool.shutdownNow();try{if(ownershipLock!=null)ownershipLock.release();if(ownershipFile!=null)ownershipFile.close();}catch(IOException ignored){}activity.stopService(new Intent(activity,GenerationService.class));}
}




