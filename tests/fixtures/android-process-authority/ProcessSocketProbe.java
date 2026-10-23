package maclauncher.android;

import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.system.OsConstants;
import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;
import org.json.*;

/** Exercises the actual inherited supervisor socket and SCM_RIGHTS receive boundary. */
public final class ProcessSocketProbe {
    static final List<ParcelFileDescriptor> sockets=new ArrayList<>();
    public static void main(String[] args)throws Exception{
        RuntimeFixture.initialize(args[0],args[1]);
        Method receive=ProcessAuthority.class.getDeclaredMethod("receiveNative",int.class);receive.setAccessible(true);
        Class<?> packet=Class.forName("maclauncher.android.ProcessAuthority$Packet");Method bytes=packet.getDeclaredMethod("bytes"),fd=packet.getDeclaredMethod("fd");bytes.setAccessible(true);fd.setAccessible(true);
        var authority=ParcelFileDescriptor.adoptFd(5);var output=new DataOutputStream(new FileOutputStream(authority.getFileDescriptor()));
        JSONObject initial=null;
        try{
            for(;;){if(initial!=null)Thread.sleep(300);Object value;try{value=receive.invoke(null,5);}catch(InvocationTargetException failure){throw new AssertionError(failure.getCause());}if(value==null)break;
                JSONObject message=new JSONObject(new String((byte[])bytes.invoke(value),StandardCharsets.UTF_8));int transferred=(int)fd.invoke(value);
                if(initial==null){initial=message;if(initial.getJSONObject("self").getInt("pid")!=(int)ProcessHandle.current().pid())throw new AssertionError("Actual PID differs");System.out.println(initial);
                    if(args[2].startsWith("game"))for(int i=0;i<2;i++){byte[] request="{\"op\":\"connect\",\"packageName\":\"example.service\",\"processName\":\"example.service:needed\"}".getBytes(StandardCharsets.UTF_8);output.writeInt(request.length);output.write(request);output.flush();}
                    if(args[2].equals("leave"))System.exit(0);
                    continue;
                }
                if(message.getString("op").equals("unavailable")){if(!args[2].equals("game-unavailable"))throw new AssertionError(message);System.out.println("{\"unavailable\":true}");continue;}
                if(transferred<0)throw new AssertionError("Actual descriptor was not transferred");
                ParcelFileDescriptor socket=ParcelFileDescriptor.adoptFd(transferred);sockets.add(socket);
                // Process death may race capability receipt. The retirement
                // scenario waits for the authenticated unavailable message.
                if(args[2].equals("game-unavailable")){socket.close();sockets.remove(socket);continue;}
                // This raw stream fixture needs blocking reads; the real
                // Binder transport supplies its own polling.
                var descriptor=socket.getFileDescriptor();int flags=Os.fcntlInt(descriptor,OsConstants.F_GETFL,0);Os.fcntlInt(descriptor,OsConstants.F_SETFL,flags&~OsConstants.O_NONBLOCK);
                Thread worker=new Thread(()->{try{byte[] expected="actual transferred capability".getBytes(StandardCharsets.UTF_8),received=new byte[expected.length];
                    if(!message.getBoolean("server"))Os.write(socket.getFileDescriptor(),expected,0,expected.length);
                    int at=0;while(at<received.length){int count=Os.read(socket.getFileDescriptor(),received,at,received.length-at);if(count<=0)throw new EOFException("Socket stopped at "+at);at+=count;}
                    if(!Arrays.equals(expected,received))throw new AssertionError("Socket bytes changed");
                    if(message.getBoolean("server"))Os.write(socket.getFileDescriptor(),received,0,received.length);
                    else System.out.println("{\"echo\":true}");
                }catch(Throwable failure){failure.printStackTrace();System.exit(2);}},"Transferred capability");worker.setDaemon(true);worker.start();
            }
        }finally{for(var socket:sockets)socket.close();authority.close();}
        System.exit(0);
    }
}
