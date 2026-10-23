package com.maclauncher.google;

import android.accounts.Account;
import android.accounts.AccountManager;
import android.accounts.AuthenticatorDescription;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Bundle;
import android.os.Looper;
import android.provider.Settings;
import android.system.Os;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Original Android account operations; request/reply data stays on inherited pipes. */
public final class GoogleControl {
    private static Context systemContext() throws Exception {
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Object thread = activityThread.getMethod("systemMain").invoke(null);
        return (Context) activityThread.getMethod("getSystemContext").invoke(thread);
    }

    private static String digest(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format("%02x", value & 255));
        return result.toString();
    }

    private static PackageInfo caller(Context context, JSONObject request) throws Exception {
        String name = request.getString("packageName");
        PackageInfo info = context.getPackageManager().getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES);
        if (info.applicationInfo == null || info.applicationInfo.uid < 10000) throw new SecurityException();
        ArrayList<String> actual = new ArrayList<>();
        for (Signature signature : info.signingInfo.getApkContentsSigners()) actual.add(digest(signature.toByteArray()));
        String[] signers = actual.toArray(new String[0]); Arrays.sort(signers);
        JSONArray expected = request.getJSONArray("signers");
        String[] selected = new String[expected.length()];
        for (int i = 0; i < selected.length; i++) selected[i] = expected.getString(i);
        Arrays.sort(selected);
        if (!Arrays.equals(signers, selected)) throw new SecurityException();
        return info;
    }

    private static Bundle options(JSONObject input) throws Exception {
        Bundle result = new Bundle();
        if (input == null) return result;
        Iterator<String> keys = input.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            // AccountManager supplies these from the actual Binder caller.
            if (key.equals("callerUid") || key.equals("callerPid") || key.equals("androidPackageName") || key.equals("clientPackageName")) continue;
            Object value = input.get(key);
            if (value == JSONObject.NULL) continue;
            if (value instanceof String) result.putString(key, (String) value);
            else if (value instanceof Boolean) result.putBoolean(key, (Boolean) value);
            else if (value instanceof Integer) result.putInt(key, (Integer) value);
            else if (value instanceof Number) result.putLong(key, ((Number) value).longValue());
            else if (value instanceof JSONObject) result.putBundle(key, options((JSONObject) value));
            else if (value instanceof JSONArray) {
                JSONArray array = (JSONArray) value;
                String[] strings = new String[array.length()];
                for (int i = 0; i < strings.length; i++) strings[i] = array.getString(i);
                result.putStringArray(key, strings);
            } else throw new IllegalArgumentException();
        }
        return result;
    }

    private static JSONObject operate(Context system, JSONObject request) throws Exception {
        String operation = request.getString("operation");
        Context context = system;
        if (operation.equals("verifyCaller") || operation.equals("token") || operation.equals("peekToken") || operation.equals("invalidateToken")) {
            PackageInfo app = caller(system, request);
            if (operation.equals("verifyCaller")) return new JSONObject().put("packageName", app.packageName).put("uid", app.applicationInfo.uid);
            context = system.createPackageContext(app.packageName, 0);
            Os.setgid(app.applicationInfo.uid); Os.setuid(app.applicationInfo.uid);
        }
        AccountManager manager = AccountManager.get(context);
        if (operation.equals("accounts")) {
            boolean provider = false;
            for (AuthenticatorDescription authenticator : manager.getAuthenticatorTypes())
                if (authenticator.type.equals("com.google") && authenticator.packageName.equals("com.google.android.gms")) provider = true;
            if (!provider) throw new IllegalStateException();
            JSONArray accounts = new JSONArray();
            for (Account account : manager.getAccountsByType("com.google")) accounts.put(new JSONObject().put("name", account.name).put("type", account.type));
            return new JSONObject().put("accounts", accounts).put("canSignIn", true);
        }
        if (operation.equals("addAccount")) {
            Intent intent = new Intent(Settings.ACTION_ADD_ACCOUNT).putExtra(Settings.EXTRA_ACCOUNT_TYPES, new String[]{"com.google"});
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return new JSONObject().put("completed", false).put("interactionStarted", true);
        }
        JSONObject identity = request.optJSONObject("account");
        if (identity == null || !identity.getString("type").equals("com.google")) throw new IllegalArgumentException();
        Account account = new Account(identity.getString("name"), "com.google");
        if (operation.equals("removeAccount")) {
            Bundle result = manager.removeAccount(account, null, null, null).getResult(60, TimeUnit.SECONDS);
            if (result.containsKey(AccountManager.KEY_INTENT)) return new JSONObject().put("completed", false).put("interactiveRequired", true);
            return new JSONObject().put("completed", result.getBoolean(AccountManager.KEY_BOOLEAN_RESULT));
        }
        if (operation.equals("invalidateToken")) {
            manager.invalidateAuthToken(account.type, request.getString("token"));
            return new JSONObject();
        }
        String service = request.getString("service");
        if (operation.equals("peekToken")) return new JSONObject().put("token", manager.peekAuthToken(account, service));
        if (!operation.equals("token")) throw new IllegalArgumentException();
        Bundle result = manager.getAuthToken(account, service, options(request.optJSONObject("options")), false, null, null).getResult(60, TimeUnit.SECONDS);
        if (result.containsKey(AccountManager.KEY_INTENT)) return new JSONObject().put("interactiveRequired", true);
        if (result.containsKey(AccountManager.KEY_ERROR_CODE)) return new JSONObject().put("providerCode", result.getInt(AccountManager.KEY_ERROR_CODE));
        String token = result.getString(AccountManager.KEY_AUTHTOKEN);
        if (token == null || token.isEmpty()) throw new IllegalStateException();
        JSONObject reply = new JSONObject().put("token", token);
        if (result.containsKey("android.accounts.expiry")) reply.put("expirySeconds", result.getLong("android.accounts.expiry"));
        return reply;
    }

    public static void main(String[] args) throws Exception {
        if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
        final Context context = systemContext();
        // System account administration uses its real Android package/UID. Token
        // requests later drop to the installed original application's UID.
        // AIM's root exec identity has no supplementary groups. UID stays root
        // until the worker selects a real caller; no credentials cross profiles.
        Os.setgid(1000);
        new Thread(() -> {
            JSONObject reply = new JSONObject();
            try {
                BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
                String line = reader.readLine();
                if (line == null || line.length() > 1024 * 1024) throw new IllegalArgumentException();
                JSONObject request = new JSONObject(line);
                if (!request.has("packageName")) Os.setuid(1000);
                reply.put("ok", true).put("result", operate(context, request));
            } catch (Throwable failure) {
                // Provider messages can contain account names, credentials or
                // tokens. Only stable error identities cross this control pipe.
                try { reply = new JSONObject().put("ok", false).put("error", new JSONObject()
                    .put("code", failure instanceof java.io.IOException ? 3
                        : failure instanceof android.accounts.OperationCanceledException ? 4
                        : failure instanceof SecurityException ? 9
                        : failure instanceof IllegalArgumentException ? 7 : 5)); }
                catch (Exception ignored) { }
            }
            System.out.println(reply.toString()); System.out.flush(); System.exit(0);
        }, "GoogleAccountControl").start();
        Looper.loop();
    }
}
