/** Compile the actual NativeBridge, then execute its HTTP method on a JVM.
 * Android UI/JSON boundaries are host stubs; HttpURLConnection and HTTP are real.
 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const run = fs.mkdtempSync(path.join(root, '.runtime/native-http-'))
const jdk = process.env.JAVA_HOME || path.join(root, '.runtime/android-toolchain/jdk17/jdk-17.0.20.1+1')
const sdk = process.env.ANDROID_HOME || path.join(root, '.runtime/android-toolchain/android-sdk')
const java = path.join(jdk, 'bin/java.exe'), javac = path.join(jdk, 'bin/javac.exe')
const androidJar = path.join(sdk, 'platforms/android-35/android.jar')
const previousClasses = path.join(root, 'android/build/intermediates/javac/debug/compileDebugJavaWithJavac/classes')
const nativeSource = path.join(root, 'android/java/io/github/ethanyoq/ainovelwriter/NativeBridge.java')
const bridgeClasses = path.join(run, 'native'), hostClasses = path.join(run, 'host'), sources = path.join(run, 'src')
for (const directory of [bridgeClasses, hostClasses, sources]) fs.mkdirSync(directory, { recursive: true })
const files = {
  'android/content/Context.java': `package android.content; public class Context { public ComponentName startForegroundService(Intent value){return null;} public boolean stopService(Intent value){return true;} }`,
  'android/content/Intent.java': `package android.content; public class Intent { public Intent(Context context,Class<?> target){} }`,
  'android/app/Activity.java': `package android.app; public class Activity extends android.content.Context { public void runOnUiThread(Runnable action){action.run();} public android.view.Window getWindow(){return new android.view.Window();} public boolean isFinishing(){return false;} }`,
  'android/view/Window.java': `package android.view; public class Window { public void addFlags(int flags){} public void clearFlags(int flags){} }`,
  'android/webkit/WebView.java': `package android.webkit; public class WebView { public final java.util.List<String> scripts=new java.util.ArrayList<>(); public void evaluateJavascript(String code,ValueCallback<String> result){scripts.add(code);} }`,
  'android/util/Base64.java': `package android.util; public class Base64 { public static final int NO_WRAP=2,DEFAULT=0; public static String encodeToString(byte[] value,int flags){return java.util.Base64.getEncoder().encodeToString(value);} public static byte[] decode(String value,int flags){return java.util.Base64.getDecoder().decode(value);} }`,
  'io/github/ethanyoq/ainovelwriter/MainActivity.java': `package io.github.ethanyoq.ainovelwriter; public class MainActivity extends android.app.Activity {}`,
  'io/github/ethanyoq/ainovelwriter/GenerationService.java': `package io.github.ethanyoq.ainovelwriter; public class GenerationService {}`,
  'io/github/ethanyoq/ainovelwriter/GoogleDriveAuthorization.java': `package io.github.ethanyoq.ainovelwriter; public class GoogleDriveAuthorization {}`,
  'io/github/ethanyoq/ainovelwriter/DeviceSecureStorage.java': `package io.github.ethanyoq.ainovelwriter; public class DeviceSecureStorage { public static class Failure extends Exception { public String code="SYNTHETIC_ONLY";} }`,
  'org/json/JSONObject.java': String.raw`package org.json; import java.util.*; public class JSONObject {
    public static final Object NULL=new Object(); final Map<String,Object> values=new LinkedHashMap<>();
    public JSONObject(){} public JSONObject(String ignored){throw new UnsupportedOperationException("Host JSON parser is not used");}
    public JSONObject put(String key,Object value){values.put(key,value);return this;} public Object get(String key){if(!values.containsKey(key))throw new IllegalArgumentException(key);return values.get(key);}
    public JSONObject put(String key,int value){return put(key,(Object)value);} public JSONObject put(String key,long value){return put(key,(Object)value);} public JSONObject put(String key,double value){return put(key,(Object)value);} public JSONObject put(String key,boolean value){return put(key,(Object)value);}
    public Object opt(String key){return values.get(key);} public String getString(String key){return String.valueOf(get(key));}
    public String optString(String key){return optString(key,"");} public String optString(String key,String fallback){Object value=values.get(key);return value==null||value==NULL?fallback:String.valueOf(value);}
    public int optInt(String key,int fallback){Object value=values.get(key);return value instanceof Number?((Number)value).intValue():fallback;}
    public boolean isNull(String key){return !values.containsKey(key)||values.get(key)==null||values.get(key)==NULL;}
    public JSONObject optJSONObject(String key){Object value=values.get(key);return value instanceof JSONObject?(JSONObject)value:null;}
    public Iterator<String> keys(){return values.keySet().iterator();} public Object remove(String key){return values.remove(key);}
    public static String quote(String text){StringBuilder out=new StringBuilder("\"");for(char c:text.toCharArray()){switch(c){case '"':out.append("\\\"");break;case '\\':out.append("\\\\");break;case '\n':out.append("\\n");break;case '\r':out.append("\\r");break;case '\t':out.append("\\t");break;default:if(c<32)out.append(String.format("\\u%04x",(int)c));else out.append(c);}}return out.append('"').toString();}
    static String json(Object value){if(value==null||value==NULL)return "null";if(value instanceof String)return quote((String)value);return value.toString();}
    public String toString(){StringBuilder out=new StringBuilder("{");for(Map.Entry<String,Object> item:values.entrySet()){if(out.length()>1)out.append(',');out.append(quote(item.getKey())).append(':').append(json(item.getValue()));}return out.append('}').toString();}
  }`,
  'org/json/JSONArray.java': `package org.json; public class JSONArray { final java.util.List<Object> values=new java.util.ArrayList<>(); public JSONArray put(Object value){values.add(value);return this;} public String getString(int index){return String.valueOf(values.get(index));} public JSONObject optJSONObject(int index){return index<values.size()&&values.get(index) instanceof JSONObject?(JSONObject)values.get(index):null;} public String toString(){StringBuilder out=new StringBuilder("[");for(Object value:values){if(out.length()>1)out.append(',');out.append(JSONObject.json(value));}return out.append(']').toString();} }`,
  'io/github/ethanyoq/ainovelwriter/NativeHttpHost.java': `package io.github.ethanyoq.ainovelwriter;
    import java.lang.reflect.*; import java.util.*; import java.util.concurrent.*; import org.json.*;
    public class NativeHttpHost {
      static void set(Object value,String name,Object member)throws Exception{Field field=NativeBridge.class.getDeclaredField(name);field.setAccessible(true);field.set(value,member);}
      public static void main(String[] args)throws Exception{
        Field field=sun.misc.Unsafe.class.getDeclaredField("theUnsafe");field.setAccessible(true);sun.misc.Unsafe unsafe=(sun.misc.Unsafe)field.get(null);
        NativeBridge bridge=(NativeBridge)unsafe.allocateInstance(NativeBridge.class);android.webkit.WebView web=new android.webkit.WebView();
        set(bridge,"activity",new MainActivity());set(bridge,"web",web);set(bridge,"requests",new ConcurrentHashMap<>());set(bridge,"canceledRequests",ConcurrentHashMap.newKeySet());
        Method send=NativeBridge.class.getDeclaredMethod("http",String.class,JSONArray.class);send.setAccessible(true);JSONArray cases=new JSONArray();
        String[][] requests={{"manual308range","manual","PUT"},{"manual308location","manual","POST"},{"manual307location","manual","POST"},{"manual303location","manual","POST"},{"manual302location","manual","POST"},{"error308location","error","POST"},{"error308range","error","PUT"},{"follow303location","follow","POST"},{"follow307location","follow","POST"},{"timeoutHeaders","error","POST"},{"timeoutBody","error","POST"}};
        for(String[] request:requests){web.scripts.clear();JSONObject options=new JSONObject().put("method",request[2]).put("redirect",request[1]).put("timeoutMs",request[0].startsWith("timeout")?100:5000)
          .put("headers",new JSONObject().put("Authorization","Bearer SYNTHETIC_NATIVE_HTTP_ONLY")).put("body",java.util.Base64.getEncoder().encodeToString("four".getBytes("UTF-8")));
          send.invoke(bridge,request[0],new JSONArray().put(args[0]+"/"+request[0]).put(options));JSONArray events=new JSONArray();for(String script:web.scripts)events.put(script);cases.put(new JSONObject().put("id",request[0]).put("scripts",events));}
        System.out.println(cases.toString());
      }
    }`,
}
for (const [relative, content] of Object.entries(files)) { const file = path.join(sources, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
function compile(args, log) {
  const result = spawnSync(javac, args, { cwd: root, encoding: 'utf8', windowsHide: true })
  fs.writeFileSync(path.join(run, log), `${result.stdout || ''}${result.stderr || ''}`)
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, `javac failed; see ${path.join(run, log)}`)
}
let sourceServer, sinkServer
const sourceRequests = [], sinkRequests = [], checks = []
try {
  assert.ok(fs.existsSync(androidJar) && fs.existsSync(previousClasses), 'Build the native Android classes once before this host test')
  compile(['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-cp', [androidJar, previousClasses].join(path.delimiter), '-d', bridgeClasses, nativeSource], 'native-javac.log')
  compile(['-encoding', 'UTF-8', '-cp', [bridgeClasses, androidJar, previousClasses].join(path.delimiter), '-d', hostClasses,
    ...Object.keys(files).map(relative => path.join(sources, relative))], 'host-javac.log')
  const receive = async request => { const chunks=[]; for await(const chunk of request)chunks.push(chunk); return { method: request.method, path: request.url, bytes:Buffer.concat(chunks).length, authorizationPresent:!!request.headers.authorization } }
  sinkServer = http.createServer(async (request,response)=>{sinkRequests.push(await receive(request));response.end('sink')})
  await new Promise(resolve=>sinkServer.listen(0,'127.0.0.1',resolve))
  sourceServer = http.createServer(async (request,response)=>{
    const received=await receive(request);sourceRequests.push(received)
    if(request.url==='/timeoutHeaders')return
    if(request.url==='/timeoutBody'){response.writeHead(200);response.write('partial');return}
    const status=Number(/(302|303|307|308)/.exec(request.url)[0]);response.statusCode=status;response.setHeader('Range','bytes=0-3')
    if(request.url.includes('location'))response.setHeader('Location',`http://127.0.0.1:${sinkServer.address().port}/sink${request.url}`)
    response.end('resume-response')
  })
  await new Promise(resolve=>sourceServer.listen(0,'127.0.0.1',resolve))
  const output = await new Promise((resolve,reject)=>{
    const child=spawn(java,['-cp',[hostClasses,bridgeClasses,androidJar].join(path.delimiter),'io.github.ethanyoq.ainovelwriter.NativeHttpHost',`http://127.0.0.1:${sourceServer.address().port}`],{cwd:root,windowsHide:true})
    let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);child.once('error',reject)
    child.once('exit',code=>{fs.writeFileSync(path.join(run,'java-stderr.log'),stderr);if(code!==0)reject(new Error(`Native HTTP host exited ${code}: ${stderr}`));else resolve(stdout)})
  })
  fs.writeFileSync(path.join(run,'host-events.json'),output)
  const results=JSON.parse(output).map(item=>({...item,events:item.scripts.map(script=>{const args=script.slice(script.indexOf('(')+1,-1);return JSON.parse(`[${args}]`)})}))
  for(const item of results){
    const events=item.events.map(([_id,name,data])=>({name,data})),header=events.find(event=>event.name==='headers')?.data,error=events.find(event=>event.name==='error')
    const responseBody=Buffer.concat(events.filter(event=>event.name==='data').map(event=>Buffer.from(event.data,'base64'))).toString('utf8')
    assert.equal(sourceRequests.filter(request=>request.path===`/${item.id}`).length,1,'Native transport replayed an original request')
    const sinks=sinkRequests.filter(request=>request.path===`/sink/${item.id}`)
    if(item.id.startsWith('timeout')){
      assert.equal(error?.data.code,'NETWORK_TIMEOUT');assert.equal(sinks.length,0);assert.ok(!events.some(event=>event.name==='end'))
      if(item.id==='timeoutHeaders')assert.equal(header,undefined)
      else {assert.equal(header.status,200);assert.equal(responseBody,'partial')}
    }else if(item.id.startsWith('manual')||item.id==='error308range'){
      assert.equal(sinks.length,0,'Manual/error transport followed a redirect')
      assert.equal(header.status,Number(/(302|303|307|308)/.exec(item.id)[0]));assert.equal(header.headers.range,'bytes=0-3');assert.ok(events.some(event=>event.name==='end'));assert.equal(error,undefined)
      assert.equal(responseBody,'resume-response')
      if(item.id.includes('location'))assert.ok(header.headers.location)
    }else if(item.id==='error308location'){assert.equal(sinks.length,0);assert.ok(error);assert.equal(header,undefined)}
    else {assert.equal(sinks.length,1);assert.equal(sinks[0].authorizationPresent,false);assert.equal(header.status,200);assert.equal(responseBody,'sink');assert.equal(sinks[0].method,item.id==='follow303location'?'GET':'POST');assert.equal(sinks[0].bytes,item.id==='follow303location'?0:4)}
    checks.push({name:item.id,passed:true,sinkRequests:sinks.length,status:header?.status,errorReported:!!error})
  }
}catch(error){process.exitCode=1;checks.push({passed:false,error:String(error.stack||error)});console.error(error.stack||error)}
finally{
  await Promise.all([sourceServer,sinkServer].filter(Boolean).map(server=>new Promise(resolve=>server.close(resolve))))
  const report={passed:checks.length===11&&checks.every(check=>check.passed),target:'actual NativeBridge HTTP bytecode compiled against Android SDK35, JVM HttpURLConnection with UI/JSON stubs',deviceTest:false,
    nativeSourceSha256:createHash('sha256').update(fs.readFileSync(nativeSource)).digest('hex'),checks,sourceRequests,sinkRequests,artifacts:run}
  fs.writeFileSync(path.join(root,'.runtime/android-native-http-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))
}
