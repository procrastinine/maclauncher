package maclauncher.android.fixture;

import android.accounts.AccountManager;
import android.app.PropertyInvalidatedCache;
import com.android.internal.os.ApplicationSharedMemory;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Original framework cache algorithms and actual Darwin shared mappings. */
public final class ApplicationSharedMemoryProbe {
    private static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    private static final class Cache extends PropertyInvalidatedCache<Integer,Integer> {
        int calls,value;
        Cache(String property){super(4,property);}
        @Override public Integer recompute(Integer query){calls++;return value+query;}
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=data.resolve("fixture.apk");
        android.content.res.FixtureApk.main(new String[]{apk.toString()});
        var loop=RuntimeFixture.initialize(args[0],args[1]);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        HostContext.hostApplicationIdentity(android.os.Process.myUid(),0);HostStorageService.install();
        try {
            HostApplication.prepare(ApplicationSharedMemoryProbe.class.getClassLoader());
            var root=ApplicationSharedMemory.getInstance();
            check(root.isMutable(),"local services require the original writable root");
            HostApplicationSharedMemory.initialize();
            check(root==ApplicationSharedMemory.getInstance(),"initialization must preserve the root owner");
            // This is the exact original call that previously failed during AccountsDb creation.
            AccountManager.invalidateLocalAccountsDataCaches();

            String property=PropertyInvalidatedCache.createPropertyName(PropertyInvalidatedCache.MODULE_SYSTEM,"ownedCacheProbe");
            Cache first=new Cache(property),second=new Cache(property);
            first.invalidateCache();long before=first.getNonce();
            check(before>3||before<0,"original nonce must be enabled");
            check(first.query(1)==1&&first.query(1)==1&&first.calls==1,"first cache must hit");
            check(second.query(1)==1&&second.query(1)==1&&second.calls==1,"second cache must hit");
            first.value=second.value=10;
            check(first.query(1)==1,"cached value must remain until invalidation");
            first.invalidateCache();
            check(first.getNonce()!=before,"invalidation must publish another actual nonce");
            check(first.query(1)==11&&second.query(1)==11&&first.calls==2&&second.calls==2,"both clients must recompute");

            try(var memory=ApplicationSharedMemory.create()) {
                check(memory.readSystemFeaturesCache().length==0,"features start empty");
                try { memory.getLatestNetworkTimeUnixEpochMillisAtZeroElapsedRealtimeMillis();throw new AssertionError("unset network time"); }
                catch(java.time.DateTimeException expected){}
                try(var reader=ApplicationSharedMemory.fromFileDescriptor(memory.getReadOnlyFileDescriptor(),false)) {
                    check(!reader.isMutable(),"reader must remain immutable");
                    memory.setLatestNetworkTimeUnixEpochMillisAtZeroElapsedRealtimeMillis(1234);
                    check(reader.getLatestNetworkTimeUnixEpochMillisAtZeroElapsedRealtimeMillis()==1234,"read-only mapping observes writes");
                    memory.writeSystemFeaturesCache(new int[]{0,2,7});
                    check(Arrays.equals(reader.readSystemFeaturesCache(),new int[]{0,2,7}),"feature cache shares its actual data");
                    try { memory.writeSystemFeaturesCache(new int[]{8});throw new AssertionError("second feature write"); }
                    catch(IllegalStateException expected){}
                    var writer=new PropertyInvalidatedCache.NonceStore(memory.getSystemNonceBlock(),true);
                    var nonces=new PropertyInvalidatedCache.NonceStore(reader.getSystemNonceBlock(),false);
                    check(writer.mMaxNonce==128&&writer.mMaxByte==8192,"original system nonce sizing");
                    int index=writer.storeName("mappingProbe");writer.setNonce(index,0x123456789abcdefL);
                    check(nonces.getHandleForName("mappingProbe")==index&&nonces.getNonce(index)==0x123456789abcdefL,"names and nonce values publish across maps");
                    try { nonces.setNonce(index,7);throw new AssertionError("immutable nonce write"); }
                    catch(RuntimeException expected){}
                    try(var output=new FileOutputStream(memory.getReadOnlyFileDescriptor())) {
                        try { output.write(1);throw new AssertionError("read-only descriptor accepted write"); }
                        catch(IOException expected){}
                    }
                    try(var copy=ApplicationSharedMemory.fromFileDescriptor(reader.getReadOnlyFileDescriptor(),false)) {
                        check(copy.getLatestNetworkTimeUnixEpochMillisAtZeroElapsedRealtimeMillis()==1234,"received read-only descriptor can be duplicated");
                    }
                    memory.closeFileDescriptor();
                    memory.setLatestNetworkTimeUnixEpochMillisAtZeroElapsedRealtimeMillis(5678);
                    check(reader.getLatestNetworkTimeUnixEpochMillisAtZeroElapsedRealtimeMillis()==5678,"mapping survives descriptor close");
                    memory.close();
                    check(reader.getLatestNetworkTimeUnixEpochMillisAtZeroElapsedRealtimeMillis()==5678,"reader survives writer retirement");
                }
                check(!memory.isMapped(),"explicit owner must unmap");
            }
            HostApplication.shutdown();
            check(root.isMapped(),"static original cache pointers must survive application retirement");
            first.invalidateCache();check(first.query(1)==11&&first.calls==3,"process cache remains usable");
            AccountManager.invalidateLocalAccountsDataCaches();
            System.out.println("PASS original cache invalidation, shared mappings, read-only descriptors and process lifetime");
        }finally {
            HostApplication.shutdown();HostLooper.close(loop);FrameworkResources.shutdown();
        }
    }
}
