/** Actual NativeBridge bytecode against SDK35; pool/transaction boundaries are JVM contract stubs. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const run = fs.mkdtempSync(path.join(root, '.runtime/native-sqlite-'))
const jdk = process.env.JAVA_HOME || path.join(root, '.runtime/android-toolchain/jdk17/jdk-17.0.20.1+1')
const sdk = process.env.ANDROID_HOME || path.join(root, '.runtime/android-toolchain/android-sdk')
const androidJar = path.join(sdk, 'platforms/android-35/android.jar')
const existing = path.join(root, 'android/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes')
const nativeSource = path.join(root, 'android/java/io/github/ethanyoq/ainovelwriter/NativeBridge.java')
const nativeClasses = path.join(run, 'native'), hostClasses = path.join(run, 'host'), source = path.join(run, 'src')
for (const directory of [nativeClasses, hostClasses, source]) fs.mkdirSync(directory, { recursive: true })
const files = {
  'android/database/Cursor.java': `package android.database; public interface Cursor extends java.io.Closeable {boolean moveToFirst(); long getLong(int column); void close();}`,
  'org/json/JSONArray.java': `package org.json; public class JSONArray {private int length; public int length(){return length;} public JSONArray put(Object value){length++;return this;}}`,
  'android/database/sqlite/SQLiteDatabase.java': `package android.database.sqlite; import android.database.Cursor;
    public class SQLiteDatabase {public boolean transaction,readonly,fail,ignore,foreign;public int poolCalls,perConnectionCalls;
      public boolean inTransaction(){return transaction;}public boolean isReadOnly(){return readonly;}
      public void setForeignKeyConstraintsEnabled(boolean value){if(transaction)throw new AssertionError("pool changed inside transaction");if(fail)throw new IllegalStateException("synthetic pool failure");poolCalls++;if(!ignore)foreign=value;}
      public void execPerConnectionSQL(String sql,Object[] args){if(transaction)throw new AssertionError("per-connection changed inside transaction");perConnectionCalls++;if(!ignore)foreign=sql.endsWith("1");}
      public Cursor rawQuery(String sql,String[] args){if(!sql.equals("PRAGMA foreign_keys"))throw new AssertionError(sql);return new Cursor(){public boolean moveToFirst(){return true;}public long getLong(int c){return foreign?1:0;}public void close(){}};}
    }`,
  'io/github/ethanyoq/ainovelwriter/NativeSqliteHost.java': `package io.github.ethanyoq.ainovelwriter; import android.database.sqlite.SQLiteDatabase; import org.json.JSONArray;
    public class NativeSqliteHost {static int checks;static void check(boolean value){if(!value)throw new AssertionError("contract check "+checks);checks++;}
      public static void main(String[] args)throws Exception{
        SQLiteDatabase db=new SQLiteDatabase();
        for(String sql:new String[]{"PRAGMA foreign_keys = ON","pragma foreign_keys=true;"," PRAGMA main.foreign_keys = 1 ","PRAGMA foreign_keys=YES"}){check(NativeBridge.configureForeignKeys(db,sql,null));check(db.foreign);}
        for(String sql:new String[]{"PRAGMA foreign_keys=OFF","PRAGMA foreign_keys=false","PRAGMA foreign_keys=0","PRAGMA foreign_keys=NO"}){check(NativeBridge.configureForeignKeys(db,sql,new JSONArray()));check(!db.foreign);}
        int before=db.poolCalls;
        for(String sql:new String[]{"PRAGMA foreign_keys","SELECT 'PRAGMA foreign_keys=ON'","PRAGMA foreign_keys=ON; SELECT 1","PRAGMA foreign_keys=unsupported","PRAGMA temp.foreign_keys=ON","-- comment\\nPRAGMA foreign_keys=ON","PRAGMA foreign_keys = ?"})check(!NativeBridge.configureForeignKeys(db,sql,null));
        check(db.poolCalls==before);check(!NativeBridge.configureForeignKeys(db,"PRAGMA foreign_keys=ON",new JSONArray().put(1)));
        db.transaction=true;check(!NativeBridge.configureForeignKeys(db,"PRAGMA foreign_keys=ON",null));check(db.poolCalls==before);db.transaction=false;
        db.readonly=true;check(NativeBridge.configureForeignKeys(db,"PRAGMA foreign_keys=ON",null));check(db.foreign&&db.perConnectionCalls==1&&db.poolCalls==before);db.readonly=false;
        db.fail=true;boolean failed=false;try{NativeBridge.configureForeignKeys(db,"PRAGMA foreign_keys=ON",null);}catch(IllegalStateException expected){failed=true;}check(failed);db.fail=false;
        db.ignore=true;db.foreign=false;failed=false;try{NativeBridge.configureForeignKeys(db,"PRAGMA foreign_keys=ON",null);}catch(java.io.IOException expected){failed=expected.getMessage().equals("SQLITE_FOREIGN_KEYS_CONFIGURATION_FAILED");}check(failed);
        System.out.println(checks);
      }
    }`,
}
for (const [relative, content] of Object.entries(files)) { const file = path.join(source, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function execute(executable, args, log) {
  const result = spawnSync(path.join(jdk, 'bin', executable), args, { cwd: root, windowsHide: true, encoding: 'utf8' })
  fs.writeFileSync(path.join(run, log), `${result.stdout || ''}${result.stderr || ''}`)
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `See ${path.join(run, log)}`)
  return result.stdout.trim()
}
let report
try {
  execute('javac.exe', ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', [androidJar, existing].join(path.delimiter), '-d', nativeClasses, nativeSource], 'native-compile.log')
  execute('javac.exe', ['-encoding', 'UTF-8', '-cp', [nativeClasses, androidJar, existing].join(path.delimiter), '-d', hostClasses, ...Object.keys(files).map(file => path.join(source, file))], 'contract-compile.log')
  const checks = Number(execute('java.exe', ['-cp', [hostClasses, nativeClasses, existing, androidJar].join(path.delimiter), 'io.github.ethanyoq.ainovelwriter.NativeSqliteHost'], 'contract.log'))
  assert.ok(checks >= 30)
  report = { passed: true, checks, target: 'actual NativeBridge SDK35 bytecode with JVM SQLite pool/transaction contract stubs', deviceTest: false }
} catch (error) { report = { passed: false, error: String(error.stack || error), deviceTest: false }; process.exitCode = 1 }
report.nativeSourceSha256 = createHash('sha256').update(fs.readFileSync(nativeSource)).digest('hex')
report.artifacts = run
fs.writeFileSync(path.join(root, '.runtime/auth-project-native-sqlite-contract.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
