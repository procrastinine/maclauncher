package maclauncher.android.fixture;

import android.os.*;
import maclauncher.android.framework.*;
import java.io.*;
import java.nio.file.*;

/** Real sockets exercise transport loss without replacing Binder or its clients. */
public final class OptionalServiceProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        var peer=new HostBinderRpc.Peer("fixture.provider","fixture.provider",(int)ProcessHandle.current().pid(),10001);
        for(int index=0;index<8;index++){
            var pair=ParcelFileDescriptor.createSocketPair();
            try(var socket=pair[0]){
                pair[1].close();
                try{HostBinderRpc.connect(socket,peer,1);throw new AssertionError("Disconnected provider connected");}
                catch(HostBinderRpc.PeerUnavailableException expected){}
            }
        }
        // A pipe is an invalid bootstrap protocol, not an unavailable provider.
        var pipe=ParcelFileDescriptor.createPipe();
        try(var input=pipe[0];var output=pipe[1]){
            try{HostBinderRpc.connect(input,peer,1);throw new AssertionError("Invalid descriptor was treated as optional");}
            catch(HostBinderRpc.PeerUnavailableException swallowed){throw new AssertionError("Invalid transport classified as peer loss",swallowed);}
            catch(IOException|IllegalArgumentException expected){}
        }
        var pair=ParcelFileDescriptor.createSocketPair();
        try(var input=pair[0];var output=pair[1]){
            try{HostBinderRpc.connect(input,peer,-1);throw new AssertionError("Invalid callback count was swallowed");}
            catch(IllegalArgumentException expected){}
        }
        System.out.println("PASS optional Binder transport loss does not hide invalid descriptors or arguments");
    }
}
