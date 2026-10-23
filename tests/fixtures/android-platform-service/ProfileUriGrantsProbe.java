package maclauncher.android;

import android.app.Application;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.framework.*;

/** Original Context/ContentResolver calls through the real profile service. */
public final class ProfileUriGrantsProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),apk=Path.of(args[2]);String name=args[3],mode=args[4];
        Path files=Files.createDirectories(data.resolve("files")),cache=Files.createDirectories(data.resolve("cache"));
        RuntimeBootstrap.initialize(runtime,data,files,cache,name,false,false,false);Looper loop=null;
        try(var authority=ProcessAuthority.read(5,name,name)){
            HostProcessIdentity.configure(authority.self.uid(),authority.self.gid(),authority.self.groups(),authority.self.hostUid(),authority.self.securityContext());authority.attachPlatform();
            FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
            HostContext.hostPackage(name,"1",1);HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);
            HostContext.hostApplicationIdentity(authority.self.uid(),0);HostContext.hostFilesDirectory(files.toString());HostContext.hostCacheDirectory(cache.toString());
            HostPackages.inspectSources(List.of(apk));loop=HostLooper.main();HostApplication.prepare(ProfileUriGrantsProbe.class.getClassLoader());
            Context context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
            Uri uri=Uri.parse("content://fixture.grants/folder/item");int read=Intent.FLAG_GRANT_READ_URI_PERMISSION;
            if(mode.equals("grant")){
                context.grantUriPermission("fixture.client",uri,read|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            }else if(mode.equals("read")||mode.equals("restore")){
                check(context.checkUriPermission(uri,android.os.Process.myPid(),authority.self.uid(),read)==PackageManager.PERMISSION_GRANTED,"shared owner must retain the original recipient grant");
                check(context.checkUriPermission(uri,android.os.Process.myPid(),authority.self.uid(),Intent.FLAG_GRANT_WRITE_URI_PERMISSION)==PackageManager.PERMISSION_DENIED,"read grant must not become write");
                if(mode.equals("read"))context.getContentResolver().takePersistableUriPermission(uri,read);
            }else if(mode.equals("denied")){
                check(context.checkUriPermission(uri,android.os.Process.myPid(),authority.self.uid(),read)==PackageManager.PERMISSION_DENIED,"uninstall retires original persisted and transient grants");
            }else throw new AssertionError(mode);
            check(context.getSystemService(android.accounts.AccountManager.class).getAccounts().length==0,"framework owner starts without an authenticator or selected Google account");
            System.out.println("PASS shared original URI service "+mode);
        }finally{HostApplication.shutdown();if(loop!=null)HostLooper.close(loop);FrameworkResources.shutdown();HostRemoteServices.shutdown();}
        System.exit(0);
    }
}
