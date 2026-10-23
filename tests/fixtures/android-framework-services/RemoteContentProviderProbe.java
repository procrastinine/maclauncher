package maclauncher.android.framework;

import android.app.*;
import android.content.*;
import android.database.*;
import android.net.Uri;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Actual original resolver/provider/cursor transactions between separate JVMs. */
public final class RemoteContentProviderProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static final List<String> lifecycle=new ArrayList<>();
    static int shutdowns;
    public static final class ProviderApplication extends Application {
        @Override public String getPackageName(){return "fixture.application.wrapper";}
        @Override public void onCreate(){
            check(lifecycle.equals(List.of("PrivateProvider","Provider")),"original providers initialize before Application.onCreate in initOrder");
            lifecycle.add("Application");
        }
    }
    public static class Provider extends ContentProvider {
        @Override public boolean onCreate(){
            check(Looper.myLooper()==Looper.getMainLooper(),"original provider main-Looper lifecycle");
            check("fixture.server".equals(getContext().getPackageName()),"original provider context follows ApplicationInfo package");
            check(getContext().getApplicationContext() instanceof ProviderApplication,"original provider retains its Application");
            lifecycle.add(getClass().getSimpleName());return true;
        }
        @Override public void shutdown(){shutdowns++;super.shutdown();}
        @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){
            check(Binder.getCallingUid()==20002,"authenticated query UID");
            check("fixture.client".equals(getCallingPackage()),"original calling package attribution");
            MatrixCursor cursor=new MatrixCursor(new String[]{"_id","value","empty","blob","wide","fraction"});
            int count=uri.getLastPathSegment().equals("small")?1:5000;
            for(int i=0;i<count;i++)cursor.addRow(new Object[]{i,"row-"+i+"-雪🙂-"+"x".repeat(count==1?1:128),null,new byte[]{0,1,(byte)255,(byte)i},Long.MIN_VALUE+i,Math.PI+i});
            return cursor;
        }
        @Override public Bundle call(String method,String arg,Bundle extras){Bundle value=new Bundle();value.putInt("pid",android.os.Process.myPid());value.putInt("uid",Binder.getCallingUid());return value;}
        @Override public ParcelFileDescriptor openFile(Uri uri,String mode)throws java.io.FileNotFoundException{
            try{Path file=getContext().getFilesDir().toPath().resolve("transfer");Files.writeString(file,"original provider descriptor");return ParcelFileDescriptor.open(file.toFile(),ParcelFileDescriptor.MODE_READ_ONLY);}
            catch(java.io.IOException error){throw new java.io.FileNotFoundException(error.toString());}
        }
        @Override public String getType(Uri uri){return "text/plain";}
        @Override public Uri insert(Uri uri,ContentValues values){return uri;}
        @Override public int delete(Uri uri,String selection,String[] args){return 0;}
        @Override public int update(Uri uri,ContentValues values,String selection,String[] args){return 0;}
    }
    public static final class PrivateProvider extends Provider {}
    public static final class DisabledProvider extends Provider {
        @Override public boolean onCreate(){throw new AssertionError("disabled provider instantiated");}
    }
    public static void main(String[] args)throws Exception{
        String role=args[0],other=role.equals("server")?"client":"server";
        Path root=Path.of(args[3]),data=Files.createDirectories(root.resolve(role)),runtime=Path.of(args[2]);
        int uid=role.equals("server")?20001:20002,peerUid=role.equals("server")?20002:20001;
        Looper loop=RuntimeFixture.initialize(runtime.toString(),data.toString(),runtime.resolve("native/libklepton-graphics.dylib").toString());
        HostProcessIdentity.configure(uid,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        Files.writeString(root.resolve(role+"-pid"),Integer.toString(android.os.Process.myPid()));
        long identityDeadline=System.nanoTime()+5_000_000_000L;while(!Files.exists(root.resolve(other+"-pid"))&&System.nanoTime()<identityDeadline)Thread.sleep(5);
        int peerPid=Integer.parseInt(Files.readString(root.resolve(other+"-pid")));
        Path apk=root.resolve(role+".apk");HostContext.hostPackage("fixture."+role,"1",1);
        HostContext.hostApplicationInfo(false,apk.toString(),data.toString(),data.toString(),28);HostContext.hostApplicationIdentity(uid,0);
        FrameworkResources.configure(runtime.resolve("android-framework.jar"),List.of(apk));
        var inspected=HostPackages.inspectSources(List.of(apk));
        var installed=new org.json.JSONObject().put("packageName","fixture."+other).put("sourceApks",new org.json.JSONArray().put(root.resolve(other+".apk").toString())).put("dataRoot",root.resolve(other).toString()).put("nativeRoot",root.resolve(other).toString()).put("uid",peerUid).put("firstInstallTime",1).put("lastUpdateTime",1);
        HostPackages.inspectInstalled(new org.json.JSONArray().put(installed).toString());
        HostStorageService.install();HostApplication.prepare(RemoteContentProviderProbe.class.getClassLoader());
        Context context=HostApplication.applicationContext();Application app=role.equals("server")?new ProviderApplication():new Application();HostApplication.attach(app,context);
        var peer=new HostBinderRpc.Peer("fixture."+other,"fixture."+other,peerPid,peerUid);
        try(var bootstrap=ParcelFileDescriptor.adoptFd(Integer.parseInt(args[5]));var providers=new maclauncher.android.LocalProviders();var directory=new HostServiceDirectory(context)){
            if(role.equals("server")){
                var connection=HostBinderRpc.serve(bootstrap,peer,directory.root(),4);
                // ActivityManager retains its original generated local AIDL
                // client. Inspect the actual lifecycle owner only in this test.
                var serviceField=HostApplication.class.getDeclaredField("services");serviceField.setAccessible(true);
                var service=(HostActivityService)serviceField.get(HostApplication.current());
                var ownerField=HostActivityService.class.getDeclaredField("providers");ownerField.setAccessible(true);
                var refsField=HostProviderConnections.class.getDeclaredField("references");refsField.setAccessible(true);
                Object owner=ownerField.get(service);
                long deadline=System.nanoTime()+15_000_000_000L;
                while(count(refsField,owner)==0&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
                check(count(refsField,owner)>0,"acquisition waits for original publication");
                check(!Objects.equals(app.getPackageName(),app.getApplicationInfo().packageName),"Application override differs from its original manifest package");
                var processProviders=new ArrayList<>(inspected.stream().filter(info->Objects.equals(info.processName,HostContext.hostProcessName())).toList());
                for(var info:processProviders)info.initOrder=info.name.equals(PrivateProvider.class.getName())?20:10;
                for(boolean applicationEnabled:new boolean[]{true,false}){
                    var disabled=new android.content.pm.ProviderInfo(processProviders.get(0));
                    disabled.applicationInfo=new android.content.pm.ApplicationInfo(disabled.applicationInfo);
                    disabled.name=DisabledProvider.class.getName();disabled.authority="fixture.disabled."+applicationEnabled;
                    disabled.enabled=!applicationEnabled;disabled.applicationInfo.enabled=applicationEnabled;processProviders.add(disabled);
                }
                try(var operation=HostContextServices.installProviders(app,processProviders,providers,false)){
                    check(providers.size()==2,"disabled component and application flags exclude provider creation");
                    check(providers.acquire("fixture.disabled.true")==null&&providers.acquire("fixture.disabled.false")==null,"disabled providers remain unpublished");
                    HostApplication.create(app);
                    check(lifecycle.equals(List.of("PrivateProvider","Provider","Application")),"original provider and Application lifecycle remains single-owned");
                }
                check(HostServices.manager().checkService(ContentResolver.CONTENT_SERVICE_NAME)!=null,"provider installation retains the content-service lease");
                while(!Files.exists(root.resolve("client-done"))&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
                check(Files.exists(root.resolve("client-done")),"client completed original operations");
                deadline=System.nanoTime()+2_000_000_000L;
                while(count(refsField,owner)!=0&&System.nanoTime()<deadline)Thread.sleep(5);
                check(count(refsField,owner)==0,"peer death retires all connection references");
                check(providers.require("fixture.rows")!=null,"client retirement preserves owner provider");
                IContentProvider retained=providers.acquire("fixture.alias");
                providers.close();providers.close();
                check(HostServices.manager().checkService(ContentResolver.CONTENT_SERVICE_NAME)==null,"provider retirement releases the owned content-service lease");
                check(retained==ActivityThread.currentActivityThread().acquireExistingProvider(context,"fixture.alias",context.getUserId(),true),"ActivityThread retains its original published provider after adapter retirement");
                check(shutdowns==0&&lifecycle.size()==3,"adapter retirement does not invoke test-only provider shutdown or repeat creation");
                System.out.println("PASS provider context and lifecycle: overridden Application package, original manifest context, disabled flags, initOrder, content-service lease and retained ActivityThread ownership");
                connection.close();connection.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
            }else{
                var localManager=ActivityManager.getService();int[] failedStarts={0};
                HostRemoteServices.resolver((process,request)->{failedStarts[0]++;HostRemoteServices.unavailable(process,request);});
                check(context.getContentResolver().acquireUnstableContentProviderClient("fixture.rows")==null,"failed app-provider startup is absent, not system death");
                check(failedStarts[0]==1&&ActivityManager.getService()==localManager,"the local ActivityManager survives another application's failed provider");
                HostRemoteServices.resolver((process,request)->{});
                var connection=HostBinderRpc.connect(bootstrap,peer,4);HostRemoteServices.attach(connection,connection.root());
                var resolved=HostPackages.service().resolveContentProvider("fixture.rows",android.content.pm.PackageManager.GET_META_DATA,context.getUserId());
                check(resolved!=null,"installed provider metadata resolves, user="+context.getUserId());
                check(Objects.equals(resolved.processName,peer.processName()),"manifest process matches transport: "+resolved.processName);
                var directoryField=HostRemoteServices.class.getDeclaredField("processes");directoryField.setAccessible(true);
                var remoteDirectory=(HostProcessServices)directoryField.get(null);
                check(remoteDirectory.find(resolved.packageName,resolved.processName)!=null,"authenticated provider process exists");
                check(remoteDirectory.find(resolved.packageName,resolved.processName).service(Context.ACTIVITY_SERVICE)!=null,"remote ActivityManager is published");
                ContentResolver resolver=context.getContentResolver();
                try(var client=resolver.acquireContentProviderClient("fixture.alias")){
                    check(client!=null,"published authority alias");Bundle result=client.call("owner",null,null);check(result.getInt("pid")==peer.pid()&&result.getInt("uid")==uid,"original provider and caller identities");
                }
                try(var input=resolver.openInputStream(Uri.parse("content://fixture.rows/file"))){check(new String(input.readAllBytes()).equals("original provider descriptor"),"owned file descriptor transfer");}
                try{resolver.acquireContentProviderClient("fixture.private");throw new AssertionError("private provider exported");}catch(SecurityException expected){}
                var manager=IActivityManager.Stub.asInterface(IServiceManager.Stub.asInterface(connection.root()).checkService(Context.ACTIVITY_SERVICE));
                try{manager.getContentProvider(ActivityThread.currentActivityThread().getApplicationThread(),"fixture.server","fixture.rows",0,true);throw new AssertionError("caller spoof accepted");}catch(SecurityException expected){}
                long deadline=System.nanoTime()+1500_000_000L;while(System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
                try(var reacquired=resolver.acquireContentProviderClient("fixture.rows")){check(reacquired.call("owner",null,null).getInt("pid")==peer.pid(),"released provider reacquires original owner");}
                for(String size:List.of("small","items"))try(Cursor cursor=resolver.query(Uri.parse("content://fixture.rows/"+size),null,null,null,null)){
                    int count=size.equals("small")?1:5000,row=count-1;
                    check(cursor!=null&&cursor.getCount()==count,"original remote bulk cursor row count");
                    check(cursor.moveToPosition(row)&&cursor.getLong(0)==row&&cursor.getString(1).startsWith("row-"+row+"-雪🙂-"),"original CursorWindow UTF-8/integer transferred/retrieved");
                    check(cursor.isNull(2)&&cursor.getType(2)==Cursor.FIELD_TYPE_NULL,"original null field");
                    check(Arrays.equals(cursor.getBlob(3),new byte[]{0,1,(byte)255,(byte)row}),"original blob field");
                    check(cursor.getLong(4)==Long.MIN_VALUE+row,"original signed 64-bit field");
                    check(cursor.getDouble(5)==Math.PI+row,"original floating-point field");
                }
                // Leave one real borrowed reference: transport death, not test
                // cleanup, must retire the owner's outstanding client record.
                resolver.acquireContentProviderClient("fixture.alias");Files.writeString(root.resolve("client-done"),"done");
                HostRemoteServices.shutdown();connection.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);
                System.out.println("PASS remote original providers: failed startup preserves ActivityManager, delayed publication, signed permissions, bulk cursor, descriptors, release/reacquire and peer death");
            }
        }catch(Exception|Error failure){failure.printStackTrace();throw failure;}
        finally{HostRemoteServices.shutdown();HostApplication.shutdown();HostWindowManager.shutdown();FrameworkResources.shutdown();HostLooper.close(loop);HostContext.hostShutdown();}
    }
    static int count(java.lang.reflect.Field field,Object owner)throws Exception{synchronized(owner){return ((Map<?,?>)field.get(owner)).size();}}
}
