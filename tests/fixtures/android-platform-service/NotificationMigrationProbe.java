package maclauncher.android.framework;

import android.app.NotificationChannel;
import java.io.*;
import java.nio.file.*;
import java.util.Arrays;
import maclauncher.android.fixture.RuntimeFixture;

/** Channel settings saved in the earlier MLN1 record layout remain the
 * application's settings after the store moves to original Parcel records. */
public final class NotificationMigrationProbe {
    private static final int LEGACY=0x4d4c4e31,CURRENT=0x4d4c4e32;
    private record Legacy(String id,String name,int importance,String description,boolean lights,int color,boolean badge,int visibility,boolean deleted){}
    private static final Legacy RETAINED=new Legacy("retained","Retained channel",2,"Previous settings",true,0x123456,false,-1,false);
    private static final Legacy REMOVED=new Legacy("removed","Removed channel",4,null,false,0,true,1,true);
    private static void check(boolean value,String detail){if(!value)throw new AssertionError(detail);}
    private static byte[] legacy(int count,Legacy... records)throws IOException{
        var bytes=new ByteArrayOutputStream();
        try(var out=new DataOutputStream(bytes)){
            out.writeInt(LEGACY);out.writeInt(count);
            for(Legacy value:records){
                out.writeUTF(value.id);out.writeUTF(value.name);out.writeInt(value.importance);
                out.writeBoolean(value.description!=null);if(value.description!=null)out.writeUTF(value.description);
                out.writeBoolean(value.lights);out.writeInt(value.color);out.writeBoolean(value.badge);
                out.writeInt(value.visibility);out.writeBoolean(value.deleted);
            }
        }
        return bytes.toByteArray();
    }
    private static boolean same(NotificationChannel channel,Legacy value){
        return channel!=null&&channel.getId().equals(value.id)&&channel.getName().toString().equals(value.name)
                &&channel.getImportance()==value.importance&&java.util.Objects.equals(channel.getDescription(),value.description)
                &&channel.shouldShowLights()==value.lights&&channel.getLightColor()==value.color&&channel.canShowBadge()==value.badge
                &&channel.getLockscreenVisibility()==value.visibility;
    }
    private static int magic(Path file)throws IOException{try(var input=new DataInputStream(Files.newInputStream(file))){return input.readInt();}}
    private static void rejects(Path file,byte[] bytes,String detail)throws IOException{
        Files.write(file,bytes);var store=new HostNotificationChannels(file);boolean rejected=false;
        try{store.getNotificationChannels();}catch(UncheckedIOException expected){rejected=true;}
        check(rejected,"malformed record accepted: "+detail);
        rejected=false;try{store.createNotificationChannel(new NotificationChannel("new","New",3));}catch(UncheckedIOException expected){rejected=true;}
        check(rejected,"damaged store replaced by a new one: "+detail);
        check(Arrays.equals(bytes,Files.readAllBytes(file)),"source record changed: "+detail);
    }
    static void run(Path data)throws Exception{
        Path file=Files.createDirectories(data.resolve("channels")).resolve("notification-channels.bin");
        check(new HostNotificationChannels(file).getNotificationChannels().isEmpty()&&!Files.exists(file),"absent source");
        byte[] bytes=legacy(2,RETAINED,REMOVED);Files.write(file,bytes);
        var store=new HostNotificationChannels(file);var values=store.getNotificationChannels();
        check(values.size()==1&&same(values.getFirst(),RETAINED),"retained channel fields");
        check(same(store.getNotificationChannel("retained"),RETAINED)&&store.getNotificationChannel("removed")==null,"deleted channel remains deleted");
        check(Arrays.equals(bytes,Files.readAllBytes(file)),"reading migrated settings modified the source");
        // Original NotificationManager semantics: re-creating a deleted channel
        // restores its saved settings; an application re-registering a channel
        // at startup updates its text but cannot raise the saved importance.
        store.createNotificationChannel(new NotificationChannel("removed","Requested again",1));
        var registered=new NotificationChannel("retained","Retained channel",4);registered.setDescription("Previous settings");
        store.createNotificationChannel(registered);
        check(magic(file)==CURRENT,"first write keeps the legacy layout");
        var reopened=new HostNotificationChannels(file);
        check(same(reopened.getNotificationChannel("removed"),REMOVED),"restored channel settings changed: "+reopened.getNotificationChannel("removed"));
        check(same(reopened.getNotificationChannel("retained"),RETAINED),"retained channel settings changed: "+reopened.getNotificationChannel("retained"));
        check(reopened.getNotificationChannels().size()==2,"migrated channel count");
        rejects(file,legacy(2,RETAINED,RETAINED),"duplicate channel");
        rejects(file,legacy(2,RETAINED),"missing record");
        rejects(file,Arrays.copyOf(bytes,bytes.length-1),"truncated record");
        rejects(file,Arrays.copyOf(bytes,bytes.length+1),"trailing data");
        Files.delete(file);Files.createSymbolicLink(file,Path.of("other.bin"));
        boolean rejected=false;try{new HostNotificationChannels(file).getNotificationChannels();}catch(UncheckedIOException expected){rejected=true;}
        check(rejected,"linked source accepted");
        System.out.println("PASS retained notification settings and read-only migration validation");
    }
    public static void main(String[] args)throws Exception {
        var loop=RuntimeFixture.initialize(args[0],args[1]);
        try{run(Path.of(args[1]));}finally{HostLooper.close(loop);}
        System.exit(0);
    }
}
