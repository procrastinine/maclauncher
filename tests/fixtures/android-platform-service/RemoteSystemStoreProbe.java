package maclauncher.android;

import android.os.*;
import com.android.internal.os.IDropBoxManagerService;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import maclauncher.android.framework.*;

public final class RemoteSystemStoreProbe {
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);String name=args[2],mode=args[3];
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        RuntimeBootstrap.initialize(runtime,data,files,cache,name,false,false,false);
        try(var authority=ProcessAuthority.read(5,name,name)) {
            HostProcessIdentity.configure(authority.self.uid(),authority.self.gid(),authority.self.groups(),authority.self.hostUid(),authority.self.securityContext());
            authority.attachPlatform();
            android.security.keystore2.AndroidKeyStoreProvider.install();
            var keys=java.security.KeyStore.getInstance("AndroidKeyStore");keys.load(null);
            if(keys.containsAlias("system-service-coexistence"))throw new AssertionError("another enrolled UID's key became visible");
            var service=IDropBoxManagerService.Stub.asInterface(ServiceManager.getService("dropbox"));
            if(service==null||!service.isTagEnabled("profile-diagnostics"))throw new AssertionError("original remote service missing");
            if(mode.equals("write")){
                var generator=javax.crypto.KeyGenerator.getInstance("AES","AndroidKeyStore");
                generator.init(new android.security.keystore.KeyGenParameterSpec.Builder("system-service-coexistence",android.security.keystore.KeyProperties.PURPOSE_ENCRYPT)
                    .setKeySize(256).setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).build());
                generator.generateKey();
                service.addData("profile-diagnostics",("entry-"+authority.self.uid()).getBytes(StandardCharsets.UTF_8),DropBoxManager.IS_TEXT);
                try {service.getNextEntry("profile-diagnostics",0,name);throw new AssertionError("unprivileged app read other applications' diagnostics");}
                catch(SecurityException expected){}
            }else{
                int count=0;long after=0;java.util.Set<String> values=new java.util.HashSet<>();
                while(true){try(var entry=service.getNextEntry("profile-diagnostics",after,name)){if(entry==null)break;after=entry.getTimeMillis();values.add(entry.getText(100));count++;}}
                if(count!=2||!values.equals(java.util.Set.of("entry-10021","entry-10022")))throw new AssertionError("shared persistent entries differ: "+count);
            }
            try {Files.list(Path.of(args[4])).close();throw new AssertionError("game can read private platform storage");}catch(java.io.IOException expected){}
            System.out.println("PASS original remote diagnostic store "+mode);
        } finally {HostRemoteServices.shutdown();}
        System.exit(0);
    }
}
