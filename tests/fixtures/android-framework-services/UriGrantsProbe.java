import android.app.Application;
import android.app.IUriGrantsManager;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.*;
import com.android.server.uri.*;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

public final class UriGrantsProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    private static org.json.JSONObject installed(Path data,String name,String file,int uid)throws Exception{
        return new org.json.JSONObject().put("packageName",name).put("sourceApks",new org.json.JSONArray().put(data.resolve(file).toString()))
            .put("dataRoot",data.resolve(name).toString()).put("nativeRoot",data.resolve(name).toString()).put("uid",uid).put("firstInstallTime",1).put("lastUpdateTime",1);
    }
    public static void main(String[] args){try{run(args);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),framework=runtime.resolve("android-framework.jar");
        var loop=RuntimeFixture.initialize(args[0],args[1]);HostProcessIdentity.configure(1000,501);
        FrameworkResources.configure(framework,List.of(framework));HostContext.hostPackage("android","16",1);
        HostContext.hostApplicationInfo(0,framework.toString(),data.toString(),runtime.resolve("native").toString(),0);HostContext.hostApplicationIdentity(1000,0);
        HostPackages.inspectSources(List.of(framework));
        HostPackages.inspectInstalled(new org.json.JSONArray().put(installed(data,"fixture.grants","provider.apk",12000)).put(installed(data,"fixture.client","client.apk",11000)).toString());
        HostStorageService.install();HostApplication.prepare(UriGrantsProbe.class.getClassLoader());Context context=HostApplication.applicationContext();HostApplication.attach(new Application(),context);
        var statistics=new HostStats(context);statistics.ready();HostUriGrants.start(context);
        var original=IUriGrantsManager.Stub.asInterface(ServiceManager.getService(Context.URI_GRANTS_SERVICE));var internal=HostUriGrants.owner();
        Uri uri=Uri.parse("content://fixture.grants/folder/item"),other=Uri.parse("content://fixture.grants/other");int read=Intent.FLAG_GRANT_READ_URI_PERMISSION;
        if(args.length>2&&args[2].equals("restore")){
            check(internal.checkUriPermission(new GrantUri(0,uri,read),11000,read,false),"original persisted grant restores in a new system process with complete installed metadata");
            original.releasePersistableUriPermission(uri,read,"fixture.client",0);
            check(!internal.checkUriPermission(new GrantUri(0,uri,read),11000,read,false),"restored grant revocation");
            HostUriGrants.flush();statistics.close();System.out.println("PASS original URI grants restore after owner restart");System.exit(0);return;
        }
        var stats=context.getSystemService(android.app.StatsManager.class);var calls=new java.util.concurrent.atomic.AtomicInteger();
        var managerField=HostStats.class.getDeclaredField("manager");managerField.setAccessible(true);
        Object statsOwner=managerField.get(statistics);
        var pullers=statsOwner.getClass().getDeclaredField("mPullers");pullers.setAccessible(true);
        var registrations=(java.util.Map<?,?>)pullers.get(statsOwner);int before=registrations.size();
        stats.setPullAtomCallback(1000001,null,Runnable::run,(tag,events)->{calls.incrementAndGet();return android.app.StatsManager.PULL_SUCCESS;});
        check(registrations.size()==before+1&&calls.get()==0,"original stats service retains callback without fabricating native collection");
        stats.clearPullAtomCallback(1000001);check(registrations.size()==before,"original callback retirement");
        check(!internal.checkUriPermission(new GrantUri(0,uri,read),11000,read,false),"no invented initial grant");
        IBinder owner=internal.newUriPermissionOwner("original owner");
        original.grantUriPermissionFromOwner(owner,12000,"fixture.client",uri,read|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,0,0);
        check(internal.checkUriPermission(new GrantUri(0,uri,read),11000,read,false),"original grant authorizes recipient UID");
        check(!internal.checkUriPermission(new GrantUri(0,uri,read),13000,read,false)&&!internal.checkUriPermission(new GrantUri(0,other,read),11000,read,false),"UID and exact URI isolation");
        check(!internal.checkUriPermission(new GrantUri(0,uri,Intent.FLAG_GRANT_WRITE_URI_PERMISSION),11000,Intent.FLAG_GRANT_WRITE_URI_PERMISSION,false),"read does not grant write");
        original.takePersistableUriPermission(uri,read,"fixture.client",0);internal.revokeUriPermissionFromOwner(owner,uri,read,0);
        check(internal.checkUriPermission(new GrantUri(0,uri,read),11000,read,false),"persisted grant survives original owner retirement");
        HostUriGrants.flush();check(Files.size(data.resolve("system/urigrants.xml"))>0,"original atomic persistence stored in profile data");
        original.releasePersistableUriPermission(uri,read,"fixture.client",0);
        check(!internal.checkUriPermission(new GrantUri(0,uri,read),11000,read,false),"release revokes persisted access");
        try{original.grantUriPermissionFromOwner(owner,12000,"fixture.client",Uri.parse("content://fixture.grants.private/item"),read,0,0);throw new AssertionError("provider grant policy bypassed");}catch(SecurityException expected){}
        original.grantUriPermissionFromOwner(owner,12000,"fixture.client",uri,read|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,0,0);
        original.takePersistableUriPermission(uri,read,"fixture.client",0);internal.revokeUriPermissionFromOwner(owner,uri,read,0);
        System.out.println("PASS complete original URI grant owner, UID/path/mode isolation, persistence and revocation");
        HostUriGrants.flush();statistics.close();System.exit(0);
    }
}
