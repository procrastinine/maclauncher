package com.maclauncher.android.macapk;

/** Runs against the selected supplier before publishing an installation. */
public final class PrivacyProbe {
    private static void optionalSwitch(String type,String member,boolean method)throws Exception{
        Class<?> owner;
        try{owner=Class.forName(type);}catch(ClassNotFoundException absent){return;}
        Object enabled;
        if(method){
            java.lang.reflect.Method selected;
            try{selected=owner.getDeclaredMethod(member);}catch(NoSuchMethodException absent){return;}
            selected.setAccessible(true);enabled=selected.invoke(null);
        }else{
            var selected=owner.getDeclaredField(member);selected.setAccessible(true);enabled=selected.get(null);
        }
        if(!Boolean.FALSE.equals(enabled))throw new IllegalStateException("Provider privacy switch mismatch: "+member);
    }
    public static void main(String[] args)throws Exception{
        if(args.length==1&&args[0].equals("--auth")){
            Class<?> accountType=Class.forName("android.accounts.Account"),managerType=Class.forName("android.accounts.AccountManager");
            Object manager=managerType.getMethod("get",Class.forName("android.content.Context")).invoke(null,new Object[]{null});
            Object[] accounts=(Object[])managerType.getMethod("getAccountsByType",String.class).invoke(manager,"com.google");
            if(accounts.length!=1)throw new IllegalStateException("Selected account routing failed");
            Object future=managerType.getMethod("getAuthToken",accountType,String.class,boolean.class,
                Class.forName("android.accounts.AccountManagerCallback"),Class.forName("android.os.Handler")).invoke(manager,accounts[0],"oauth2:fixture",false,null,null);
            Class.forName("android.os.Looper").getMethod("getMainLooper").invoke(null);
            var getResult=Class.forName("android.accounts.AccountManagerFuture").getMethod("getResult");
            Object bundle=java.util.concurrent.CompletableFuture.supplyAsync(()->{
                try{return getResult.invoke(future);}catch(Exception failure){throw new java.util.concurrent.CompletionException(failure);}
            }).get(5,java.util.concurrent.TimeUnit.SECONDS);
            String token=(String)Class.forName("android.os.Bundle").getMethod("getString",String.class).invoke(bundle,"authtoken");
            if(!"fixture-scoped-token".equals(token))throw new IllegalStateException("Original account future token routing failed");
            Object master=Class.forName("com.macapk.gms.GmsStore").getMethod("masterToken",String.class).invoke(null,"fixture@example.invalid");
            if(master!=null)throw new IllegalStateException("Unexpected master token access");
            var appToken=Class.forName("com.macapk.gms.GoogleAuthClient").getMethod("fetchAppToken",String.class,String.class,String.class,String.class,boolean.class,boolean.class,boolean.class,String.class,java.util.Map.class,int.class,int.class);
            Object mapped=appToken.invoke(null,"fixture@example.invalid","oauth2:fixture","untrusted.caller","untrusted-signer",true,false,false,null,null,0,0);
            if(!(mapped instanceof java.util.Map<?,?> map)||!"fixture-scoped-token".equals(map.get("Auth")))throw new IllegalStateException("App token routing failed");
            managerType.getMethod("invalidateAuthToken",String.class,String.class).invoke(manager,"com.google",token);
            System.out.println("macapk-auth-1");
            return;
        }
        if(args.length==1&&args[0].equals("--clipboard")){
            var clipboard=PrivacyBridge.clipboard();
            clipboard.setContents(new java.awt.datatransfer.StringSelection("copy\n\"plain\" λ"),null);
            String text=(String)clipboard.getContents(null).getTransferData(java.awt.datatransfer.DataFlavor.stringFlavor);
            System.out.println(java.util.Base64.getEncoder().encodeToString(text.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            return;
        }
        if(!System.getProperty("user.home").equals(System.getenv("HOME")))throw new IllegalStateException("Private Java home mismatch");
        Class<?> storage=Class.forName("com.macapk.loader.SharedStorage");
        String androidRoot=(String)storage.getMethod("androidRoot").invoke(null);
        if(!androidRoot.equals(System.getenv("MACAPK_ANDROID_ROOT")))throw new IllegalStateException("Private Android root mismatch");
        Object volume=storage.getMethod("externalStorageRoot").invoke(null);
        if(!new java.io.File(androidRoot,"sdcard").equals(volume))throw new IllegalStateException("Private storage volume mismatch");
        optionalSwitch("com.macapk.loader.SharedStorage","sharedVolumeEnabled",true);
        optionalSwitch("com.macapk.loader.SharedStorage","onePathEnabled",true);
        optionalSwitch("com.macapk.loader.SharedStorage","userFoldersEnabled",true);
        optionalSwitch("android.media.session.MacApkNowPlaying","ENABLED",false);
        if(!"0".equals(System.getenv("MACAPK_OFFLINE")))optionalSwitch("com.macapk.loader.AppLinks","ON",false);
        Class<?> build=Class.forName("android.os.Build");
        if(!"Pixel Tablet".equals(build.getField("MODEL").get(null)))throw new IllegalStateException("Device profile mismatch");
        Class<?> properties=Class.forName("android.os.SystemProperties");
        if(!"google".equals(properties.getMethod("get",String.class).invoke(null,"ro.product.brand")))throw new IllegalStateException("Device properties mismatch");
        Object battery=Class.forName("android.os.BatteryManager").getConstructor().newInstance();
        if(!Integer.valueOf(100).equals(battery.getClass().getMethod("getIntProperty",int.class).invoke(battery,4)))throw new IllegalStateException("Virtual battery mismatch");
        if(!Boolean.TRUE.equals(battery.getClass().getMethod("isCharging").invoke(battery)))throw new IllegalStateException("Virtual power mismatch");
        Class<?> manager=Class.forName("android.content.ClipboardManager"),clip=Class.forName("android.content.ClipData");
        Object clipboard=manager.getConstructor().newInstance(),data=clip.getMethod("newPlainText",CharSequence.class,CharSequence.class).invoke(null,"text","private clipboard");
        manager.getMethod("setPrimaryClip",clip).invoke(clipboard,data);
        if(manager.getMethod("getPrimaryClip").invoke(clipboard)!=data)throw new IllegalStateException("Private clipboard mismatch");
        if(Boolean.TRUE.equals(Class.forName("com.macapk.loader.CameraBridge").getMethod("isAvailable").invoke(null)))throw new IllegalStateException("Camera policy mismatch");
        if(Boolean.TRUE.equals(Class.forName("com.macapk.loader.AudioInputBridge").getMethod("available").invoke(null)))throw new IllegalStateException("Microphone policy mismatch");
        Class<?> signIn=Class.forName("com.macapk.gms.NativeSignIn");
        // Simulate a bound native login window: the guest policy must still
        // refuse automatic prompts, including when network access is enabled.
        if(Boolean.getBoolean("maclauncher.test.boundSignIn")){
            var nativeAvailable=signIn.getDeclaredField("sHaveNative");nativeAvailable.setAccessible(true);nativeAvailable.set(null,Boolean.TRUE);
        }
        if(!Boolean.FALSE.equals(signIn.getMethod("available").invoke(null))||
            signIn.getMethod("promptOnce").invoke(null)!=null||signIn.getMethod("signInInteractive").invoke(null)!=null)
            throw new IllegalStateException("Guest Google sign-in policy mismatch");
        System.out.println("macapk-policy-1");
    }
}
