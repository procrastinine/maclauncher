package maclauncher.android.fixture;
import android.os.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import maclauncher.android.framework.*;

/** Original Binder sessions authenticate kernel peers and keep one native listener owner. */
public final class PlatformListenerProbe {
    static void check(boolean condition){if(!condition)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        boolean client=args.length>2;
        HostProcessIdentity.configure(client?10001:20001,(int)new com.sun.security.auth.module.UnixSystem().getUid());
        Path socket=Path.of(args[1],"binder");
        if(client){
            var peer=new HostBinderRpc.Peer("android","keystore",Integer.parseInt(args[2]),20001,"u:r:keystore:s0");
            try(var connection=HostBinderRpc.connect(socket.toString(),peer,4)){throw new AssertionError("Unenrolled process was accepted");}
            catch(IOException expected){System.out.println("DENIED");}
            check(System.in.read()==1);
            try(var connection=HostBinderRpc.connect(socket.toString(),peer,4)){
                IBinder remote=connection.root();
                Binder callback=new Binder(){@Override protected boolean onTransact(int code,Parcel request,Parcel reply,int flags){
                    check(Binder.getCallingPid()==peer.pid()&&Binder.getCallingUid()==20001);
                    check(HostBinderRpc.callingPeer().equals(peer));reply.writeInt(request.readInt()+1);return true;
                }};
                try(var workers=Executors.newFixedThreadPool(8)){
                    List<Future<?>> work=new ArrayList<>();for(int i=0;i<24;i++)work.add(workers.submit(()->{
                        Parcel request=Parcel.obtain(remote),reply=Parcel.obtain();
                        try{request.writeStrongBinder(callback);check(remote.transact(1,request,reply,0));check(reply.readInt()==42);}
                        catch(RemoteException failure){throw new IllegalStateException(failure);}
                        finally{request.recycle();reply.recycle();}
                    }));for(var future:work)future.get(10,TimeUnit.SECONDS);
                }
                System.out.println("READY RETIRE");check(System.in.read()==2);
                Parcel request=Parcel.obtain(remote),reply=Parcel.obtain();
                try{check(!remote.transact(1,request,reply,0));}
                catch(RemoteException expected){}
                finally{request.recycle();reply.recycle();}
            }
            System.out.println("PASS client");System.exit(0);
        }
        HostProcessServices identities=new HostProcessServices();
        Binder endpoint=new Binder(){@Override protected boolean onTransact(int code,Parcel request,Parcel reply,int flags)throws RemoteException{
            var peer=HostBinderRpc.callingPeer();check(peer!=null&&peer.uid()==10001&&peer.pid()==Binder.getCallingPid()&&Binder.getCallingUid()==10001);
            check(identities.expectedIdentity(peer.pid()).equals(peer));IBinder callback=request.readStrongBinder();
            Parcel input=Parcel.obtain(callback),output=Parcel.obtain();try{input.writeInt(41);check(callback.transact(1,input,output,0));reply.writeInt(output.readInt());return true;}finally{input.recycle();output.recycle();}
        }};
        var listener=HostBinderRpc.listen(socket.toString(),endpoint,identities,8);
        java.lang.Process process=new ProcessBuilder(Path.of(System.getProperty("java.home"),"bin/java").toString(),"-Xverify:all","-cp",System.getProperty("java.class.path"),PlatformListenerProbe.class.getName(),args[0],args[1],Long.toString(ProcessHandle.current().pid())).redirectError(Path.of(args[1],"client.log").toFile()).start();
        try{
            var output=new BufferedReader(new InputStreamReader(process.getInputStream()));check("DENIED".equals(output.readLine()));
            identities.expect(new HostBinderRpc.Peer("fixture.game","fixture.game",(int)process.pid(),10001));
            process.getOutputStream().write(1);process.getOutputStream().flush();
            check("READY RETIRE".equals(output.readLine()));
            var identity=identities.expectedIdentity((int)process.pid());
            var enrolled=identities.find(identity);
            var field=enrolled.getClass().getDeclaredField("connection");field.setAccessible(true);
            var connection=(HostBinderRpc.Connection)field.get(enrolled);check(connection!=null);
            identities.unavailable(identity);connection.closed().toCompletableFuture().get(5,TimeUnit.SECONDS);
            process.getOutputStream().write(2);process.getOutputStream().flush();
            check("PASS client".equals(output.readLine()));check(process.waitFor(10,TimeUnit.SECONDS)&&process.exitValue()==0);
        }finally{if(process.isAlive())process.destroyForcibly();listener.close();listener.closed().toCompletableFuture().get(10,TimeUnit.SECONDS);identities.close();}
        check(!Files.exists(socket));
        for(int i=0;i<8;i++){var immediate=HostBinderRpc.listen(socket.toString(),endpoint,new HostProcessServices(),1);immediate.close();immediate.closed().toCompletableFuture().get(5,TimeUnit.SECONDS);}
        System.out.println("PASS platform listener: actual peer enrollment, concurrent original Binder callbacks and immediate owner retirement");System.exit(0);
    }
}
