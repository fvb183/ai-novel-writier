/** Executes the production Android authorization state machine on a JVM.
 * Android UI and Google Play services are deterministic boundary fakes, not a device login.
 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'android/java/io/github/ethanyoq/ainovelwriter/GoogleDriveAuthorization.java')
const run = fs.mkdtempSync(path.join(root, '.runtime/android-google-authorization-'))
const sources = path.join(run, 'src'), classes = path.join(run, 'classes')
const jdk = process.env.JAVA_HOME || path.join(root, '.runtime/android-toolchain/jdk17/jdk-17.0.20.1+1')
const exe = name => path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : ''))
const files = {
  'android/app/Activity.java': `package android.app; public class Activity { public static final int RESULT_OK=-1,RESULT_CANCELED=0; }`,
  'android/app/PendingIntent.java': `package android.app; public class PendingIntent { public Object getIntentSender(){return this;} }`,
  'android/content/Intent.java': `package android.content; public class Intent { public Object result; public Exception failure; public Intent(Object result){this.result=result;} public Intent(Exception failure){this.failure=failure;} }`,
  'android/os/Looper.java': `package android.os; public class Looper { public static Looper getMainLooper(){return new Looper();} }`,
  'android/os/Handler.java': `package android.os; import java.util.*; public class Handler { public static final List<Runnable> delayed=new ArrayList<>(); public static final List<Long> durations=new ArrayList<>(); public Handler(Looper l){} public void post(Runnable r){r.run();} public void postDelayed(Runnable r,long delay){delayed.add(r);durations.add(delay);} public void removeCallbacks(Runnable r){delayed.remove(r);} }`,
  'com/google/android/gms/common/ConnectionResult.java': `package com.google.android.gms.common; public class ConnectionResult { public static final int SUCCESS=0; }`,
  'com/google/android/gms/common/GoogleApiAvailability.java': `package com.google.android.gms.common; public class GoogleApiAvailability { public static int status=0; public static GoogleApiAvailability getInstance(){return new GoogleApiAvailability();} public int isGooglePlayServicesAvailable(Object activity){return status;} }`,
  'com/google/android/gms/common/api/ApiException.java': `package com.google.android.gms.common.api; public class ApiException extends Exception { private final int code; public ApiException(int code){this.code=code;} public int getStatusCode(){return code;} }`,
  'com/google/android/gms/common/api/Scope.java': `package com.google.android.gms.common.api; public class Scope { public final String value; public Scope(String v){value=v;} }`,
  'com/google/android/gms/tasks/Task.java': `package com.google.android.gms.tasks; import java.util.function.Consumer; public class Task<T> { final T value; final Exception failure; public Task(T value,Exception failure){this.value=value;this.failure=failure;} public Task<T> addOnSuccessListener(Consumer<T> listener){if(failure==null)listener.accept(value);return this;} public Task<T> addOnFailureListener(Consumer<Exception> listener){if(failure!=null)listener.accept(failure);return this;} public Task<T> addOnCompleteListener(Consumer<Task<T>> listener){listener.accept(this);return this;} public boolean isSuccessful(){return failure==null;} }`,
  'com/google/android/gms/auth/api/identity/AuthorizationRequest.java': `package com.google.android.gms.auth.api.identity; import java.util.*; import com.google.android.gms.common.api.Scope; public class AuthorizationRequest { public List<Scope> scopes; public static Builder builder(){return new Builder();} public static class Builder { final AuthorizationRequest request=new AuthorizationRequest(); public Builder setRequestedScopes(List<Scope> scopes){request.scopes=scopes;return this;} public AuthorizationRequest build(){return request;} } }`,
  'com/google/android/gms/auth/api/identity/ClearTokenRequest.java': `package com.google.android.gms.auth.api.identity; public class ClearTokenRequest { public static Builder builder(){return new Builder();} public static class Builder { public Builder setToken(String token){return this;} public ClearTokenRequest build(){return new ClearTokenRequest();} } }`,
  'com/google/android/gms/auth/api/identity/AuthorizationResult.java': `package com.google.android.gms.auth.api.identity; import android.app.PendingIntent; import java.util.*; public class AuthorizationResult { public boolean resolution; public String token; public List<String> scopes; public AuthorizationResult(boolean resolution,String token,List<String> scopes){this.resolution=resolution;this.token=token;this.scopes=scopes;} public boolean hasResolution(){return resolution;} public PendingIntent getPendingIntent(){return resolution?new PendingIntent():null;} public List<String> getGrantedScopes(){return scopes;} public String getAccessToken(){return token;} }`,
  'com/google/android/gms/auth/api/identity/AuthorizationClient.java': `package com.google.android.gms.auth.api.identity; import android.content.Intent; import com.google.android.gms.tasks.Task; public class AuthorizationClient { public AuthorizationResult next; public Exception failure; public int calls,parses; public Task<AuthorizationResult> authorize(AuthorizationRequest request){calls++;if(request.scopes.size()!=1||!request.scopes.get(0).value.equals("https://www.googleapis.com/auth/drive.file"))throw new AssertionError("scope expanded");return new Task<>(next,failure);} public AuthorizationResult getAuthorizationResultFromIntent(Intent data)throws Exception {parses++;if(data.failure!=null)throw data.failure;return (AuthorizationResult)data.result;} public Task<Void> clearToken(ClearTokenRequest request){return new Task<>(null,null);} }`,
  'com/google/android/gms/auth/api/identity/Identity.java': `package com.google.android.gms.auth.api.identity; public class Identity { public static AuthorizationClient client=new AuthorizationClient(); public static AuthorizationClient getAuthorizationClient(Object activity){return client;} }`,
  'org/json/JSONObject.java': `package org.json; import java.util.*; public class JSONObject { final Map<String,Object> values=new HashMap<>(); public JSONObject put(String key,Object value){values.put(key,value);return this;} public int length(){return values.size();} public Object opt(String key){return values.get(key);} public String optString(String key){Object value=values.get(key);return value==null?"":String.valueOf(value);} public boolean optBoolean(String key){return Boolean.TRUE.equals(values.get(key));} public JSONObject optJSONObject(String key){return values.get(key) instanceof JSONObject?(JSONObject)values.get(key):null;} }`,
  'org/json/JSONArray.java': `package org.json; import java.util.*; public class JSONArray { final List<Object> values=new ArrayList<>(); public JSONArray put(Object v){values.add(v);return this;} public int length(){return values.size();} public JSONObject optJSONObject(int i){return i<values.size()&&values.get(i) instanceof JSONObject?(JSONObject)values.get(i):null;} }`,
  'io/github/ethanyoq/ainovelwriter/MainActivity.java': `package io.github.ethanyoq.ainovelwriter; import java.util.*; public class MainActivity extends android.app.Activity { public int code=-1,launches; public final List<Integer> finished=new ArrayList<>(); public void startIntentSenderForResult(Object sender,int code,Object fill,int mask,int values,int extra){this.code=code;launches++;} public void finishActivity(int code){finished.add(code);} }`,
  'io/github/ethanyoq/ainovelwriter/NativeBridge.java': `package io.github.ethanyoq.ainovelwriter; import java.util.*; import java.util.concurrent.Executor; import org.json.JSONObject; public class NativeBridge { final Executor pool=Runnable::run; final Map<String,JSONObject> responses=new LinkedHashMap<>(); public void resolve(String id,JSONObject value){if(responses.containsKey(id))throw new AssertionError("duplicate completion");responses.put(id,value);} }`,
  'io/github/ethanyoq/ainovelwriter/GoogleAuthorizationHost.java': `package io.github.ethanyoq.ainovelwriter;
import android.app.Activity; import android.content.Intent; import android.os.Handler; import java.util.*;
import com.google.android.gms.auth.api.identity.*; import com.google.android.gms.common.GoogleApiAvailability; import com.google.android.gms.common.api.ApiException; import org.json.*;
public class GoogleAuthorizationHost {
    static final String SCOPE="https://www.googleapis.com/auth/drive.file",TOKEN="SYNTHETIC_TEST_TOKEN_ONLY";
    static int checks;
    static class Fixture {
        final MainActivity activity=new MainActivity(); final NativeBridge bridge=new NativeBridge(); final AuthorizationClient client=new AuthorizationClient(); final GoogleDriveAuthorization auth;
        Fixture(){Identity.client=client;GoogleApiAvailability.status=0;Handler.delayed.clear();Handler.durations.clear();client.next=resolution();auth=new GoogleDriveAuthorization(activity,bridge);}
        void start(String id,boolean interactive){auth.request(id,"google.authorize",new JSONArray().put(new JSONObject().put("interactive",interactive)));}
        void error(String id,String expected){JSONObject reply=bridge.responses.get(id);require(reply!=null&&!reply.optBoolean("ok")&&expected.equals(reply.opt("code")),"wrong sanitized error: "+expected);}
        void success(String id){JSONObject reply=bridge.responses.get(id);require(reply!=null&&reply.optBoolean("ok")&&TOKEN.equals(reply.optJSONObject("value").opt("accessToken")),"missing token");}
    }
    static AuthorizationResult resolution(){return new AuthorizationResult(true,null,null);}
    static AuthorizationResult grant(){return new AuthorizationResult(false,TOKEN,Arrays.asList(SCOPE));}
    static void require(boolean good,String message){if(!good)throw new AssertionError(message);}
    static void pass(String name){if(checks++>0)System.out.print(",");System.out.print("{\\"name\\":\\""+name+"\\",\\"passed\\":true}");}
    public static void main(String[] args){System.out.print("[");
        Fixture f=new Fixture();f.start("a",true);require(f.activity.launches==1&&f.bridge.responses.isEmpty(),"interactive resolution not pending");f.auth.onActivityResult(f.activity.code,Activity.RESULT_OK,new Intent(grant()));f.success("a");f.auth.request("status","google.status",new JSONArray());require(f.bridge.responses.get("status").optJSONObject("value").optBoolean("authorized"),"authorized not retained");pass("interactive resolution success retains authorization");
        f=new Fixture();f.start("a",true);f.auth.onActivityResult(f.activity.code,Activity.RESULT_CANCELED,new Intent(grant()));f.success("a");require(f.client.parses==1,"Google response not parsed");pass("valid SDK result parsed regardless outer result code");
        int[] statuses={10,7,12501,16,4,5,8,15,17,20,21,22,123456};
        String[] codes={"GOOGLE_OAUTH_CONFIGURATION_REQUIRED","GOOGLE_NETWORK_ERROR","GOOGLE_AUTH_CANCELLED","GOOGLE_AUTH_INTERRUPTED","GOOGLE_AUTH_REQUIRED","GOOGLE_ACCOUNT_INVALID","GOOGLE_PLAY_SERVICES_ERROR","GOOGLE_AUTH_TIMEOUT","GOOGLE_PLAY_SERVICES_CONNECTION_FAILED","GOOGLE_PLAY_SERVICES_CONNECTION_FAILED","GOOGLE_PLAY_SERVICES_CONNECTION_FAILED","GOOGLE_PLAY_SERVICES_CONNECTION_FAILED","GOOGLE_AUTH_FAILED"};
        for(int i=0;i<statuses.length;i++){f=new Fixture();f.start("a",true);f.auth.onActivityResult(f.activity.code,Activity.RESULT_CANCELED,new Intent(new ApiException(statuses[i])));f.error("a",codes[i]);require(f.client.parses==1,"non-OK response not parsed");f.client.next=grant();f.start("retry",true);f.success("retry");pass("callback status "+statuses[i]+" preserves reason and permits retry");}
        f=new Fixture();f.start("a",true);f.auth.onActivityResult(f.activity.code,Activity.RESULT_CANCELED,null);f.error("a","GOOGLE_AUTH_INTERRUPTED");pass("absent canceled result is interruption");
        f=new Fixture();f.start("a",true);f.auth.onActivityResult(f.activity.code,Activity.RESULT_OK,null);f.error("a","GOOGLE_AUTH_RESULT_MISSING");pass("absent success result is incomplete response");
        f=new Fixture();f.client.failure=new ApiException(10);f.start("a",true);f.error("a","GOOGLE_OAUTH_CONFIGURATION_REQUIRED");require(f.activity.launches==0,"failed task launched UI");pass("initial task failure preserves configuration reason");
        f=new Fixture();f.start("a",false);f.error("a","GOOGLE_AUTH_REQUIRED");require(f.activity.launches==0,"silent status launched UI");pass("silent grant check never launches permission UI");
        f=new Fixture();f.start("a",true);int old=f.activity.code;f.auth.request("cancel","google.cancel",new JSONArray());f.error("a","GOOGLE_AUTH_CANCELLED");require(f.activity.finished.contains(old),"explicit cancel left resolution open");f.start("next",true);int newer=f.activity.code;f.auth.onActivityResult(old,Activity.RESULT_OK,new Intent(grant()));require(!f.bridge.responses.containsKey("next"),"late old callback completed new request");f.auth.onActivityResult(newer,Activity.RESULT_OK,new Intent(grant()));f.success("next");pass("explicit cancellation closes resolution and ignores stale callback");
        f=new Fixture();f.start("a",true);old=f.activity.code;Handler.delayed.get(0).run();f.error("a","GOOGLE_AUTH_TIMEOUT");f.auth.onActivityResult(old,Activity.RESULT_OK,new Intent(grant()));require(f.bridge.responses.size()==1,"late timed out callback completed again");f.client.next=grant();f.start("retry",true);f.success("retry");pass("timeout remains retryable without accepting late grant");
        f=new Fixture();f.start("a",true);f.auth.request("cancel-a","google.cancel",new JSONArray().put(new JSONObject().put("requestId","a")));f.error("a","GOOGLE_AUTH_CANCELLED");f.start("next",true);newer=f.activity.code;f.auth.request("late-cancel","google.cancel",new JSONArray().put(new JSONObject().put("requestId","a")));require(!f.bridge.responses.containsKey("next"),"stale cancellation touched newer request");f.auth.onActivityResult(newer,Activity.RESULT_OK,new Intent(grant()));f.success("next");pass("request scoped cancellation never cancels a newer authorization");
        f=new Fixture();f.start("a",true);require(Handler.durations.get(0)==180000L,"interactive permission budget shortened");f.auth.request("cancel","google.cancel",new JSONArray());f.start("silent",false);require(Handler.durations.get(1)==30000L,"silent grant budget not bounded");pass("silent and interactive native deadlines differ");
        f=new Fixture();f.client.next=new AuthorizationResult(false,TOKEN,Collections.emptyList());f.start("a",true);f.error("a","GOOGLE_AUTH_REQUIRED");pass("missing required scope never marks authorized");
        f=new Fixture();GoogleApiAvailability.status=2;f.start("a",true);f.error("a","GOOGLE_PLAY_SERVICES_UNAVAILABLE");require(f.client.calls==0,"unavailable Play services used");pass("unavailable Play services distinguished from cancellation");
        f=new Fixture();f.start("a",true);old=f.activity.code;f.auth.destroy();f.auth.onActivityResult(old,Activity.RESULT_OK,new Intent(grant()));require(f.bridge.responses.isEmpty(),"destroyed activity accepted result");f.start("next",true);f.error("next","GOOGLE_AUTH_UNAVAILABLE");pass("destroyed activity rejects new work and ignores result");
        f=new Fixture();f.start("a",true);f.start("concurrent",true);f.error("concurrent","GOOGLE_AUTH_BUSY");f.auth.onActivityResult(f.activity.code,Activity.RESULT_OK,new Intent(grant()));f.success("a");pass("concurrent request cannot replace pending authorization");
        f=new Fixture();require(!f.auth.onActivityResult(91,Activity.RESULT_OK,new Intent(grant())),"file chooser result consumed");pass("unrelated activity results remain available to file chooser");
        System.out.print("]");
    }
}`,
}

fs.mkdirSync(classes, { recursive: true })
for (const [relative, content] of Object.entries(files)) {
  const target = path.join(sources, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
const report = { passed: false, target: 'production GoogleDriveAuthorization.java state machine with JVM Android/Google API boundary fakes', deviceTest: false, realGoogleAuthorization: false, externalNetworkRequests: 0, nativeSourceSha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'), artifacts: run }
try {
  const compilation = spawnSync(exe('javac'), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-d', classes, source, ...Object.keys(files).map(relative => path.join(sources, relative))], { cwd: root, encoding: 'utf8', windowsHide: true })
  fs.writeFileSync(path.join(run, 'javac.log'), `${compilation.stdout || ''}${compilation.stderr || ''}`)
  assert.ifError(compilation.error)
  assert.equal(compilation.status, 0, `Compilation failed: ${path.join(run, 'javac.log')}`)
  const execution = spawnSync(exe('java'), ['-cp', classes, 'io.github.ethanyoq.ainovelwriter.GoogleAuthorizationHost'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  fs.writeFileSync(path.join(run, 'java-stderr.log'), execution.stderr || '')
  assert.ifError(execution.error)
  assert.equal(execution.status, 0, execution.stderr)
  report.checks = JSON.parse(execution.stdout)
  assert.equal(report.checks.length, 28)
  report.passed = report.checks.every(check => check.passed)
} catch (error) {
  report.error = String(error.stack || error)
  process.exitCode = 1
}
fs.writeFileSync(path.join(root, '.runtime/android-google-authorization-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
