package maclauncher.android.media;

import android.app.Application;
import android.media.MediaPlayer;
import android.os.Looper;
import java.io.FileInputStream;
import java.lang.reflect.Modifier;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.*;
import java.util.List;
import maclauncher.android.fixture.MediaServicesFixture;
import maclauncher.android.framework.*;

/** Exercise original media services through their public Android client. */
public final class MediaPreparationProbe {
    private static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    private static byte[] wav(){
        int samples=800;ByteBuffer value=ByteBuffer.allocate(44+samples*2).order(ByteOrder.LITTLE_ENDIAN);
        value.put(new byte[]{'R','I','F','F'}).putInt(36+samples*2).put(new byte[]{'W','A','V','E','f','m','t',' '})
            .putInt(16).putShort((short)1).putShort((short)1).putInt(8000).putInt(16000).putShort((short)2).putShort((short)16)
            .put(new byte[]{'d','a','t','a'}).putInt(samples*2);
        while(value.hasRemaining())value.putShort((short)0);return value.array();
    }
    private static void source(MediaPlayer player,Path file)throws Exception{
        byte[] audio=wav(),range=new byte[audio.length+30];System.arraycopy(audio,0,range,17,audio.length);Files.write(file,range);
        try(FileInputStream input=new FileInputStream(file.toFile())){player.setDataSource(input.getFD(),17,audio.length);}
        Files.delete(file);
    }
    private static void waitPrepared(Looper loop,int[] events)throws Exception{
        long deadline=System.nanoTime()+15_000_000_000L;
        while(events[0]==0&&events[1]==0&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
        check(events[0]==1&&events[1]==0,"original media service must prepare the retained FD range: "+java.util.Arrays.toString(events));
    }
    public static void main(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Files.createDirectories(Path.of(args[1]));
        try(var services=new MediaServicesFixture(runtime,data)){
            Looper loop=services.loop;
            check(Modifier.isNative(MediaPlayer.class.getDeclaredMethod("native_init").getModifiers()),"MediaPlayer must use its original native implementation");
            int[] events={0,0};MediaPlayer player=new MediaPlayer();
            try{
                player.setOnPreparedListener(ready->events[0]++);
                player.setOnErrorListener((failed,what,extra)->{events[1]++;return true;});
                source(player,data.resolve("retained.wav"));player.prepareAsync();waitPrepared(loop,events);
                check(player.getDuration()==100,"closed and unlinked FD range must retain the original duration");
                player.reset();events[0]=0;
                source(player,data.resolve("reused.wav"));player.prepareAsync();waitPrepared(loop,events);
                check(player.getDuration()==100,"reset must release the previous source and accept a new range");
                player.reset();events[0]=0;
                source(player,data.resolve("released.wav"));player.prepareAsync();player.release();player=null;
                for(int i=0;i<40;i++){HostLooper.drain(loop);Thread.sleep(5);}
                check(events[0]==0&&events[1]==0,"released player must not deliver stale preparation events");
                System.out.println("PASS original MediaPlayer services, retained FD ranges, reset and released events");
            }finally{if(player!=null)player.release();}
        }
        System.exit(0);
    }
}
