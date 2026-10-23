package maclauncher.android;

import android.os.*;
import com.android.internal.os.IDropBoxManagerService;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;

/** Exercises the complete supplied service, not a substitute Binder implementation. */
public final class SystemStoreProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);
        Files.createDirectories(data.resolve("files"));Files.createDirectories(data.resolve("cache"));
        RuntimeBootstrap.initialize(runtime,data,data.resolve("files"),data.resolve("cache"),"android",false,false,false);
        HostProcessIdentity.configure(1000,android.os.Process.myUid());
        HostFilesystem.installNativeMappings(List.of(),data.resolve("files"));
        Looper loop=HostLooper.main();
        try(var owner=HostSystemServices.start(runtime,data,"android.system")) {
            var context=HostApplication.applicationContext();
            DropBoxManager client=context.getSystemService(DropBoxManager.class);
            check(client!=null,"original DropBox manager available");
            String tag="local-diagnostics";
            check(client.isTagEnabled(tag),"original enabled tag");
            client.addText(tag,"Hello diagnostic store 🌱");
            byte[] dataBytes=new byte[32768];new Random(31).nextBytes(dataBytes);
            client.addData(tag,dataBytes,0);
            Path file=data.resolve("payload.txt");Files.writeString(file,"file payload");
            client.addFile(tag,file.toFile(),DropBoxManager.IS_TEXT);
            int entries=0;long after=0;
            while(true){try(var entry=client.getNextEntry(tag,after)){if(entry==null)break;
                check(entry.getTimeMillis()>after,"original monotonic entry time");after=entry.getTimeMillis();
                if(entries==0)check(entry.getText(100).equals("Hello diagnostic store 🌱"),"UTF-8 original text roundtrip");
                if(entries==1)check(Arrays.equals(entry.getInputStream().readAllBytes(),dataBytes),"compressed original binary roundtrip");
                if(entries==2)check(entry.getText(100).equals("file payload"),"original file entry roundtrip");entries++;
            }}
            check(entries==3,"all original entry variants present");
            check(Files.list(data.resolve("system/dropbox")).count()==3,"one private original store");
            check(com.android.server.LocalServices.getService(com.android.server.DropBoxManagerInternal.class).getClass().getName().startsWith("com.android.server.DropBoxManagerService$"),"original implementation owns service");
            HostLooper.drain(loop);
            System.out.println("PASS complete original diagnostic store text/binary/file, compression and private ownership");
        } finally {HostApplication.shutdown();HostLooper.close(loop);}
        System.exit(0);
    }
}
