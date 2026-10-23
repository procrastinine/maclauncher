package maclauncher.android.framework;

import java.io.*;
import java.nio.file.*;
import java.util.Arrays;

public final class NotificationMigrationProbe {
    private static void check(boolean value,String detail){if(!value)throw new AssertionError(detail);}
    private static byte[] legacy(int count)throws IOException{
        var bytes=new ByteArrayOutputStream();
        try(var out=new DataOutputStream(bytes)){
            out.writeInt(0x4d4c4e31);out.writeInt(count);
            for(int i=0;i<count;i++){
                out.writeUTF("retained");out.writeUTF("Retained channel");out.writeInt(2);
                out.writeBoolean(true);out.writeUTF("Previous settings");
                out.writeBoolean(true);out.writeInt(0x123456);out.writeBoolean(false);
                out.writeInt(-1);out.writeBoolean(true);
            }
        }
        return bytes.toByteArray();
    }
    private static void rejects(Path file,byte[] bytes)throws IOException{
        Files.write(file,bytes);boolean rejected=false;
        try{HostNotificationMigration.read(file);}catch(UncheckedIOException expected){rejected=true;}
        check(rejected,"malformed record accepted");
        check(Arrays.equals(bytes,Files.readAllBytes(file)),"source record changed");
    }
    public static void run(Path data)throws Exception{
        Path file=data.resolve("channels.bin");
        check(HostNotificationMigration.read(file).isEmpty(),"absent source");
        byte[] bytes=legacy(1);Files.write(file,bytes);
        var values=HostNotificationMigration.read(file);check(values.size()==1,"channel count");
        var channel=values.getFirst();
        check(channel.getId().equals("retained")&&channel.getImportance()==2
                &&channel.getDescription().equals("Previous settings")&&channel.shouldShowLights()
                &&channel.getLightColor()==0x123456&&!channel.canShowBadge()
                &&channel.getLockscreenVisibility()==-1&&channel.isDeleted(),"original channel fields");
        check(Arrays.equals(bytes,Files.readAllBytes(file)),"migration modified source");
        rejects(file,legacy(2));
        rejects(file,Arrays.copyOf(bytes,bytes.length-1));
        rejects(file,Arrays.copyOf(bytes,bytes.length+1));
        Files.delete(file);Files.createSymbolicLink(file,Path.of("other.bin"));
        boolean rejected=false;try{HostNotificationMigration.read(file);}catch(UncheckedIOException expected){rejected=true;}
        check(rejected,"linked source accepted");
        System.out.println("PASS retained notification settings and read-only migration validation");
    }
}
