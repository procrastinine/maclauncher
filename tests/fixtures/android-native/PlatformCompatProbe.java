package com.android.server.compat;

import android.app.Application;
import android.content.pm.ApplicationInfo;
import android.os.Looper;
import com.android.internal.compat.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Uses the supplied service, generated metadata and real framework contexts. */
public final class PlatformCompatProbe {
    private static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    private static void sharedMemoryFlags()throws Exception {
        for(var entry:Map.of(android.app.Flags.class,"picUsesSharedMemory",com.android.internal.os.Flags.class,"applicationSharedMemoryEnabled").entrySet()){
            var field=entry.getKey().getDeclaredField("FEATURE_FLAGS");field.setAccessible(true);Object original=field.get(null);
            field.set(null,java.lang.reflect.Proxy.newProxyInstance(field.getType().getClassLoader(),new Class<?>[]{field.getType()},
                (proxy,method,values)->method.getName().equals(entry.getValue())?true:method.invoke(original,values)));
        }
    }
    private static Path configurations(Path runtime,Path data)throws Exception {
        Path configs=Files.createDirectories(data.resolve("compatconfig"));
        try(var jar=new java.util.jar.JarFile(runtime.resolve("android-framework.jar").toFile())) {
            var entries=jar.stream().filter(entry->!entry.isDirectory()&&entry.getName().endsWith("_compat_config.xml")).toList();int index=0;
            for(var entry:entries)try(var input=jar.getInputStream(entry)) {
                Files.copy(input,configs.resolve((index++)+".xml"),StandardCopyOption.REPLACE_EXISTING);
            }
        }
        return configs;
    }
    private static void sharedNonces()throws Exception {
        var memory=com.android.internal.os.ApplicationSharedMemory.getInstance();
        check(memory.isMutable(),"The existing service owner must prepare writable original shared memory");
        var available=android.app.PropertyInvalidatedCache.class.getDeclaredField("sSharedMemoryAvailable");available.setAccessible(true);
        check(available.getBoolean(null),"Exercise original shared-memory nonces rather than the property fallback");
        String key="cache_key.system_server.is_compat_change_enabled";
        try(var watcher=android.app.PropertyInvalidatedCache.getNonceWatcher(key)){
            check(watcher.isChanged(),"Original directory configuration must publish its cache nonce before application binding");
            long previous=watcher.lastSeen();android.app.compat.ChangeIdStateCache.invalidate();
            check(watcher.isChanged()&&watcher.lastSeen()!=previous,"Original cache invalidation must update shared memory");
            try(var readOnly=com.android.internal.os.ApplicationSharedMemory.fromFileDescriptor(memory.getReadOnlyFileDescriptor(),false)){
                var store=new android.app.PropertyInvalidatedCache.NonceStore(readOnly.getSystemNonceBlock(),false);
                int handle=store.getHandleForName("is_compat_change_enabled");
                check(handle>=0&&store.getNonce(handle)==watcher.lastSeen(),"Original read-only mapping must observe the same nonce");
                try{store.setNonce(handle,1);throw new AssertionError("Read-only cache nonces must reject writes");}
                catch(RuntimeException expected){check("write permission denied".equals(expected.getMessage()),"Retain original read-only nonce permission");}
            }
        }
        HostApplicationSharedMemory.initialize();
        check(memory==com.android.internal.os.ApplicationSharedMemory.getInstance(),"Early and repeated preparation must retain one region");
    }
    public static void main(String[] args)throws Exception {
        boolean shared=args.length>3&&args[3].equals("shared");if(shared)sharedMemoryFlags();
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1])),apk=data.resolve("fixture.apk");
        android.content.res.FixtureApk.main(new String[]{apk.toString()});
        Looper loop=RuntimeFixture.initialize(args[0],args[1]);
        int target=Integer.parseInt(args[2]);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),target);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostStorageService.install();
        var previous=android.compat.Compatibility.getBehaviorChangeDelegate();
        try {
            if(shared){
                check(com.android.internal.os.ApplicationSharedMemory.sInstance==null,"No application binding may preinitialize the service memory");
                HostPlatformCompat.prepare(List.of(configurations(runtime,data)));
                sharedNonces();
            }
            var prepared=EarlyPackageCompatProbe.verify(target);
            var memory=com.android.internal.os.ApplicationSharedMemory.getInstance();
            HostApplication.prepare(PlatformCompatProbe.class.getClassLoader());
            check(memory==com.android.internal.os.ApplicationSharedMemory.getInstance(),"Application preparation must retain the early region");
            var context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
            var service=IPlatformCompat.Stub.asInterface(HostServices.manager().getService("platform_compat"));
            check(service!=null&&service.getClass()==PlatformCompat.class,"original PlatformCompat must own the service");
            check(service==prepared,"Package policy and application binding retain one original service owner");
            var changes=service.listAllChanges();
            check(changes.length>1,"all supplied compatibility definitions must load");
            check(android.compat.Compatibility.getBehaviorChangeDelegate().getClass()==android.app.AppCompatCallbacks.class,
                "original process callback must be installed by application binding");
            for(var change:changes)check(android.compat.Compatibility.isChangeEnabled(change.getId())==
                service.isChangeEnabled(change.getId(),context.getApplicationInfo()),
                "process callback must match the complete original configuration: "+change.getId());
            var pending=android.app.PendingIntent.class.getDeclaredMethod("checkPendingIntent",int.class,android.content.Intent.class,android.content.Context.class,boolean.class);
            pending.setAccessible(true);
            try {
                pending.invoke(null,0,new android.content.Intent("fixture.action"),context,false);
                check(target<31,"new target must retain original PendingIntent mutability check");
            }catch(java.lang.reflect.InvocationTargetException failure){
                check(target>=31&&failure.getCause() instanceof IllegalArgumentException,
                    "old target must retain original PendingIntent compatibility: "+failure.getCause());
            }
            var account=Arrays.stream(changes).filter(change->change.getId()==154726397L).findFirst().orElseThrow();
            check(account.getEnableSinceTargetSdk()==34,"account threshold must come from generated metadata");
            var app=new ApplicationInfo(context.getApplicationInfo());
            for(int sdk:new int[]{29,33,34,35}) {
                app.targetSdkVersion=sdk;
                check(service.isChangeEnabled(account.getId(),app)==(sdk>=34),"original target SDK evaluation: "+sdk);
                check(service.getAppConfig(app).disabledChanges().contains(account.getId())==(sdk<34),"original app disabled-change configuration");
            }
            var disabled=Arrays.stream(changes).filter(change->change.getDisabled()&&!change.getLoggingOnly()).findFirst().orElseThrow();
            check(!service.isChangeEnabled(disabled.getId(),app),"original disabled default must remain disabled");
            check(service.isChangeEnabled(Long.MAX_VALUE,app),"unknown change must retain original default");
            try {
                service.setOverrides(new CompatibilityChangeConfig(new android.compat.Compatibility.ChangeConfig(new HashSet<>(Set.of(account.getId())),new HashSet<>())),app.packageName);
                throw new AssertionError("compatibility reads must not authorize overrides");
            }catch(SecurityException expected){}
            check(context.checkSelfPermission("android.permission.READ_COMPAT_CHANGE_CONFIG")!=android.content.pm.PackageManager.PERMISSION_GRANTED,
                "service-local read permission must not become an application grant");
            // The image supplier uses the same generated definitions in Android
            // directories rather than a JVM CodeSource archive.
            Path configs=configurations(runtime,data);
            var current=HostPlatformCompat.class.getDeclaredField("current");current.setAccessible(true);
            ((AutoCloseable)current.get(null)).close();
            HostPlatformCompat.prepare(List.of(configs));
            var fromDirectory=IPlatformCompat.Stub.asInterface(HostServices.manager().getService("platform_compat"));
            check(fromDirectory!=service&&fromDirectory.getClass()==PlatformCompat.class,"directory input must use a fresh original owner");
            check(Arrays.equals(Arrays.stream(changes).mapToLong(change->change.getId()).sorted().toArray(),
                Arrays.stream(fromDirectory.listAllChanges()).mapToLong(change->change.getId()).sorted().toArray()),
                "directory and archive suppliers must retain the complete original definitions");
            for(var change:changes)check(fromDirectory.isChangeEnabled(change.getId(),app)==service.isChangeEnabled(change.getId(),app),
                "both original suppliers must preserve target SDK evaluation: "+change.getId());
            HostPlatformCompat.install(context,List.of(configs));
            check(HostServices.manager().getService("platform_compat")==fromDirectory.asBinder(),"Directory preparation retains its owner during binding");
            System.out.println("PASS original PlatformCompat generated metadata, target SDK defaults and override permissions: "+changes.length+" changes");
        }finally {
            HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();
        }
        check(HostServices.manager().checkService("platform_compat")==null,"compatibility service must retire with its owner");
        check(android.compat.Compatibility.getBehaviorChangeDelegate()==previous,"process callback must retire with its application binding");
    }
}
