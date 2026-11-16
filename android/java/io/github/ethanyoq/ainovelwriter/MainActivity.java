package io.github.ethanyoq.ainovelwriter;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.*;
import android.view.*;
import android.widget.FrameLayout;
import java.io.*;
import java.util.*;

/** Offline-first Android host. Only packaged resources have native privileges. */
public class MainActivity extends Activity {
    static final String ORIGIN = "https://appassets.androidplatform.net";
    WebView web;
    NativeBridge bridge;
    private ValueCallback<Uri[]> fileCallback;
    private static final int WEB_FILE = 91;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.rgb(246,245,241));
        getWindow().setNavigationBarColor(Color.rgb(246,245,241));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(246,245,241));
        FrameLayout content = new FrameLayout(this);
        content.setBackgroundColor(Color.rgb(246,245,241));
        content.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // Android 15 enforces edge-to-edge for target 35. Apply system/IME space
        // outside the WebView so every existing editor/dialog gets a usable viewport.
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(content);
        content.requestApplyInsets();
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setBuiltInZoomControls(false); s.setDisplayZoomControls(false);
        s.setUseWideViewPort(true); s.setLoadWithOverviewMode(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setTextZoom(100);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        bridge = new NativeBridge(this, web);
        web.addJavascriptInterface(bridge, "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return false;
                if (r.isForMainFrame()) openExternal(u.toString());
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView w, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!ORIGIN.equals(u.getScheme() + "://" + u.getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
                String path = u.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                try {
                    if (path.contains("..") || path.contains("\\")) throw new IOException("Invalid asset path");
                    String mime = mime(path);
                    Map<String,String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-cache");
                    headers.put("X-Content-Type-Options", "nosniff");
                    headers.put("Cross-Origin-Resource-Policy", "same-origin");
                    // Network and model credentials are managed by the native HTTP bridge.
                    headers.put("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'");
                    return new WebResourceResponse(mime, "utf-8", 200, "OK", headers, getAssets().open(path.substring(1)));
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                }
            }
            @Override public void onReceivedSslError(WebView w, android.webkit.SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); }
            @Override public boolean onRenderProcessGone(WebView w, RenderProcessGoneDetail d) {
                new AlertDialog.Builder(MainActivity.this).setTitle("界面已暂停").setMessage("Android 回收了界面进程。已保存的项目仍保留在此设备上，请重新打开应用。").setPositiveButton("重新打开", (a,b) -> recreate()).setCancelable(false).show();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onJsAlert(WebView w, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定", (d,n) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
            @Override public boolean onJsConfirm(WebView w, String url, String message, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setPositiveButton("确定", (d,n) -> result.confirm()).setNegativeButton("取消", (d,n) -> result.cancel()).setOnCancelListener(d -> result.cancel()).show(); return true;
            }
            @Override public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { startActivityForResult(params.createIntent(), WEB_FILE); } catch (Exception e) { callback.onReceiveValue(null); fileCallback = null; }
                return true;
            }
            @Override public boolean onConsoleMessage(ConsoleMessage msg) {
                android.util.Log.println(msg.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? android.util.Log.ERROR : android.util.Log.DEBUG, "VelaWeb", msg.message()); return true;
            }
        });
        web.loadUrl(ORIGIN + "/index.html");
    }
    static String mime(String name) {
        if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".json") || name.endsWith(".map")) return "application/json";
        if (name.endsWith(".woff2")) return "font/woff2";
        if (name.endsWith(".woff")) return "font/woff";
        if (name.endsWith(".wasm")) return "application/wasm";
        if (name.endsWith(".svg")) return "image/svg+xml";
        String ext = MimeTypeMap.getFileExtensionFromUrl(name);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return mime == null ? "application/octet-stream" : mime;
    }
    void openExternal(String url) {
        Uri u = Uri.parse(url);
        if (!"https".equalsIgnoreCase(u.getScheme()) && !"http".equalsIgnoreCase(u.getScheme()) && !"mailto".equalsIgnoreCase(u.getScheme())) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == WEB_FILE) {
            if (fileCallback != null) fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null; return;
        }
        bridge.onActivityResult(requestCode, resultCode, data);
    }
    @Override public void onBackPressed() {
        web.evaluateJavascript("(function(){if(globalThis.__androidBack){globalThis.__androidBack();return true}return false})()", handled -> {
            if (!"true".equals(handled)) new AlertDialog.Builder(this).setTitle("退出 " + getString(R.string.app_name) + "？").setMessage("已保存的项目会保留在此设备。进行中的 AI 任务请先等待完成或停止。").setPositiveButton("退出", (d,n) -> finish()).setNegativeButton("继续编辑", null).show();
        });
    }
    @Override protected void onPause(){super.onPause();if(web!=null)web.evaluateJavascript("window.dispatchEvent(new Event('android-background'))",null);}
    @Override protected void onDestroy() {
        if (bridge != null) bridge.destroy();
        if (web != null) { web.removeJavascriptInterface("AndroidBridge"); web.destroy(); }
        super.onDestroy();
    }
}
