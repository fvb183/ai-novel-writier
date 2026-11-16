package io.github.ethanyoq.ainovelwriter;

import android.app.Activity;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/** Google Play services owns the account/grant cache; tokens never enter a project file. */
final class GoogleDriveAuthorization {
    private static final int AUTHORIZATION_RESULT_MIN = 0x6000;
    private static final int AUTHORIZATION_RESULT_MAX = 0x7fff;
    static final String DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    private final MainActivity activity;
    private final NativeBridge bridge;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AuthorizationClient client;
    private String pendingId;
    private String lastToken;
    private Boolean authorized;
    private boolean disconnecting;
    private boolean destroyed;
    private Runnable deadline;
    private int nextResolutionCode = AUTHORIZATION_RESULT_MIN;
    private final Map<Integer, String> resolutions = new HashMap<>();

    GoogleDriveAuthorization(MainActivity activity, NativeBridge bridge) {
        this.activity = activity;
        this.bridge = bridge;
        client = Identity.getAuthorizationClient(activity);
    }

    void request(String id, String operation, JSONArray args) {
        if (destroyed) { reject(id, "GOOGLE_AUTH_UNAVAILABLE"); return; }
        if (operation.equals("google.cancel")) {
            JSONObject options = args == null || args.length() == 0 ? null : args.optJSONObject(0);
            if (args != null && args.length() > 0 && (args.length() != 1 || options == null
                || options.length() != 1 || !(options.opt("requestId") instanceof String))) {
                reject(id, "GOOGLE_AUTH_INPUT_INVALID"); return;
            }
            // A late timeout from an older WebView request must never cancel a retry.
            if (options != null && !options.optString("requestId").equals(pendingId)) { resolve(id, new JSONObject()); return; }
            String canceled = pendingId;
            if (canceled != null) {
                finishError(canceled, "GOOGLE_AUTH_CANCELLED");
                for (Map.Entry<Integer, String> entry : resolutions.entrySet()) if (entry.getValue().equals(canceled)) {
                    try { activity.finishActivity(entry.getKey()); } catch (Exception ignored) {}
                }
            }
            resolve(id, new JSONObject()); return;
        }
        if (operation.equals("google.status")) {
            try {
                JSONObject status = new JSONObject().put("available", available());
                // A previous launch's preference is not proof of a still-valid grant.
                if (authorized != null) status.put("authorized", authorized);
                resolve(id, status);
            } catch (Exception ignored) { reject(id, "GOOGLE_AUTH_FAILED"); }
            return;
        }
        if (!operation.equals("google.authorize") && !operation.equals("google.disconnect") && !operation.equals("google.invalidate")) {
            reject(id, "GOOGLE_AUTH_INPUT_INVALID"); return;
        }
        if (pendingId != null) { reject(id, "GOOGLE_AUTH_BUSY"); return; }
        if (!available()) { reject(id, "GOOGLE_PLAY_SERVICES_UNAVAILABLE"); return; }
        if (operation.equals("google.invalidate")) {
            if (args != null && args.length() != 0) { reject(id, "GOOGLE_AUTH_INPUT_INVALID"); return; }
            if (lastToken == null) { resolve(id, new JSONObject()); return; }
            final String invalid = lastToken;
            pendingId = id;
            deadline = () -> finishError(id, "GOOGLE_AUTH_TIMEOUT");
            main.postDelayed(deadline, 30_000);
            client.clearToken(ClearTokenRequest.builder().setToken(invalid).build())
                .addOnCompleteListener(task -> {
                    if (!current(id)) return;
                    if (!task.isSuccessful()) { finishError(id, "GOOGLE_TOKEN_CACHE_CLEAR_FAILED"); return; }
                    lastToken = null; authorized = null;
                    finishSuccess(id, new JSONObject());
                });
            return;
        }
        boolean interactive = false;
        if (operation.equals("google.authorize")) {
            JSONObject options = args == null || args.length() != 1 ? null : args.optJSONObject(0);
            if (options == null || options.length() != 1 || !(options.opt("interactive") instanceof Boolean)) {
                reject(id, "GOOGLE_AUTH_INPUT_INVALID"); return;
            }
            interactive = options.optBoolean("interactive");
        } else if (args != null && args.length() != 0) {
            reject(id, "GOOGLE_AUTH_INPUT_INVALID"); return;
        }
        pendingId = id;
        disconnecting = operation.equals("google.disconnect");
        final boolean allowInteraction = interactive;
        deadline = () -> finishError(id, "GOOGLE_AUTH_TIMEOUT");
        main.postDelayed(deadline, disconnecting ? 60_000 : interactive ? 180_000 : 30_000);
        try {
            AuthorizationRequest authorization = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_FILE_SCOPE))).build();
            client.authorize(authorization)
                .addOnSuccessListener(result -> handleResult(id, result, allowInteraction))
                .addOnFailureListener(error -> finishError(id, errorCode(error)));
        } catch (Exception error) { finishError(id, errorCode(error)); }
    }

    private boolean available() {
        return GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) == ConnectionResult.SUCCESS;
    }

    private boolean current(String id) { return !destroyed && id.equals(pendingId); }

    private void handleResult(String id, AuthorizationResult result, boolean interactive) {
        if (!current(id)) return;
        if (result.hasResolution()) {
            if (disconnecting) {
                // No saved grant/account remains; this operation must never open an account picker.
                lastToken = null; authorized = false; finishSuccess(id, new JSONObject()); return;
            }
            if (!interactive) { finishError(id, "GOOGLE_AUTH_REQUIRED"); return; }
            try {
                if (result.getPendingIntent() == null) { finishError(id, "GOOGLE_AUTH_FAILED"); return; }
                if (nextResolutionCode > AUTHORIZATION_RESULT_MAX) { finishError(id, "GOOGLE_AUTH_BUSY"); return; }
                int code = nextResolutionCode++;
                resolutions.put(code, id);
                activity.startIntentSenderForResult(result.getPendingIntent().getIntentSender(), code,
                    null, 0, 0, 0);
            } catch (Exception error) { finishError(id, "GOOGLE_AUTH_UNAVAILABLE"); }
            return;
        }
        if (result.getGrantedScopes() == null || !result.getGrantedScopes().contains(DRIVE_FILE_SCOPE)
            || result.getAccessToken() == null || result.getAccessToken().isEmpty()) {
            finishError(id, "GOOGLE_AUTH_REQUIRED"); return;
        }
        lastToken = result.getAccessToken();
        authorized = true;
        if (disconnecting) { revoke(id, lastToken); return; }
        try {
            // The API does not promise a token lifetime. Re-authorize silently when needed.
            finishSuccess(id, new JSONObject().put("accessToken", lastToken));
        } catch (Exception ignored) { finishError(id, "GOOGLE_AUTH_FAILED"); }
    }

    boolean onActivityResult(int code, int resultCode, Intent data) {
        if (code < AUTHORIZATION_RESULT_MIN || code > AUTHORIZATION_RESULT_MAX) return false;
        String id = resolutions.remove(code);
        if (id == null || !current(id)) return true;
        // Play services also returns failure details in a non-OK result's Intent.
        // Let its parser distinguish configuration/network failures from cancellation.
        if (data == null) {
            finishError(id, resultCode == Activity.RESULT_CANCELED
                ? "GOOGLE_AUTH_INTERRUPTED" : "GOOGLE_AUTH_RESULT_MISSING");
            return true;
        }
        try { handleResult(id, client.getAuthorizationResultFromIntent(data), false); }
        catch (Exception error) { finishError(id, errorCode(error)); }
        return true;
    }

    private void revoke(String id, String token) {
        bridge.pool.execute(() -> {
            HttpURLConnection connection = null;
            boolean revoked = false;
            try {
                connection = (HttpURLConnection) new URL("https://oauth2.googleapis.com/revoke").openConnection();
                connection.setRequestMethod("POST");
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(15_000); connection.setReadTimeout(15_000);
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                connection.setDoOutput(true);
                byte[] body = ("token=" + URLEncoder.encode(token, "UTF-8")).getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                revoked = connection.getResponseCode() == 200;
            } catch (Exception ignored) { /* Token, server text and account details never enter logs. */ }
            finally { if (connection != null) connection.disconnect(); }
            final boolean success = revoked;
            main.post(() -> {
                if (!current(id)) return;
                if (!success) { finishError(id, "GOOGLE_REVOKE_FAILED"); return; }
                client.clearToken(ClearTokenRequest.builder().setToken(token).build())
                    .addOnCompleteListener(task -> {
                        if (!current(id)) return;
                        lastToken = null; authorized = false;
                        if (task.isSuccessful()) finishSuccess(id, new JSONObject());
                        else finishError(id, "GOOGLE_TOKEN_CACHE_CLEAR_FAILED");
                    });
            });
        });
    }

    private String errorCode(Exception error) {
        if (error instanceof ApiException) {
            int code = ((ApiException) error).getStatusCode();
            if (code == 10) return "GOOGLE_OAUTH_CONFIGURATION_REQUIRED";
            if (code == 7) return "GOOGLE_NETWORK_ERROR";
            if (code == 12501) return "GOOGLE_AUTH_CANCELLED";
            // CommonStatusCodes.CANCELED includes a service/client disconnect;
            // it does not establish that the author declined the permission.
            if (code == 16) return "GOOGLE_AUTH_INTERRUPTED";
            if (code == 4) return "GOOGLE_AUTH_REQUIRED";
            if (code == 5) return "GOOGLE_ACCOUNT_INVALID";
            if (code == 8) return "GOOGLE_PLAY_SERVICES_ERROR";
            if (code == 15) return "GOOGLE_AUTH_TIMEOUT";
            if (code == 17 || code == 20 || code == 21 || code == 22) return "GOOGLE_PLAY_SERVICES_CONNECTION_FAILED";
        }
        return "GOOGLE_AUTH_FAILED";
    }

    private void finishSuccess(String id, JSONObject value) {
        if (!current(id)) return;
        clearPending(); resolve(id, value);
    }
    private void finishError(String id, String code) {
        if (!current(id)) return;
        if (code.equals("GOOGLE_AUTH_REQUIRED")) authorized = false;
        clearPending(); reject(id, code);
    }
    private void clearPending() {
        if (deadline != null) main.removeCallbacks(deadline);
        deadline = null; pendingId = null; disconnecting = false;
    }
    private void resolve(String id, JSONObject value) {
        try { bridge.resolve(id, new JSONObject().put("ok", true).put("value", value)); }
        catch (Exception ignored) { reject(id, "GOOGLE_AUTH_FAILED"); }
    }
    private void reject(String id, String code) {
        try { bridge.resolve(id, new JSONObject().put("ok", false).put("code", code).put("error", code)); }
        catch (Exception ignored) { /* Activity is leaving. */ }
    }
    void destroy() {
        destroyed = true; clearPending(); lastToken = null; authorized = null; resolutions.clear();
    }
}
