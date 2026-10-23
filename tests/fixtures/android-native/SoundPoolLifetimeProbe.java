package android.media;

import java.lang.ref.WeakReference;
import java.nio.*;
import java.nio.file.*;
import java.util.concurrent.atomic.AtomicInteger;
import maclauncher.android.framework.HostLooper;
import maclauncher.android.fixture.MediaServicesFixture;

/** Original SoundPool, decoder and native lifetime; playback data is silence. */
public final class SoundPoolLifetimeProbe {
    private static void check(boolean result,String detail){if(!result)throw new AssertionError(detail);}
    private static void until(android.os.Looper loop,java.util.function.BooleanSupplier done,String detail)throws Exception {
        long deadline=System.nanoTime()+10_000_000_000L;
        while(!done.getAsBoolean()&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
        check(done.getAsBoolean(),detail);
    }
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]),sampleFile=data.resolve("sample.wav");
        // One second of silent PCM avoids changing physical mixer volume.
        ByteBuffer wav=ByteBuffer.allocate(44+16000).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16036)
            .put("WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16)
            .putShort((short)1).putShort((short)1).putInt(8000).putInt(16000)
            .putShort((short)2).putShort((short)16)
            .put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16000);
        Files.write(sampleFile,wav.array());
        var nativeContext=SoundPool.class.getDeclaredField("mNativeContext");nativeContext.setAccessible(true);
        try(var services=new MediaServicesFixture(runtime,data)){
            var pool=new SoundPool.Builder().setMaxStreams(2).setAudioAttributes(
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).build()).build();
            try{
                check(nativeContext.getLong(pool)!=0,"original native pool allocated");
                AtomicInteger loaded=new AtomicInteger(-1);
                pool.setOnLoadCompleteListener((owner,id,status)->loaded.set(status));
                int sample=pool.load(sampleFile.toString(),1);
                check(sample>0,"original decoder accepted source");
                until(services.loop,()->loaded.get()!=-1,"original decoder callback");
                check(loaded.get()==0,"original decoder succeeded");
                int stream=pool.play(sample,0,0,1,-1,1);
                check(stream>0,"original stream allocated");
                pool.pause(stream);pool.resume(stream);pool.autoPause();pool.autoResume();
                pool.setPriority(stream,2);pool.setRate(stream,1.5f);pool.setLoop(stream,0);
                pool.stop(stream);pool.stop(stream);
                check(pool.unload(sample),"original sample unloaded");
                check(!pool.unload(sample),"sample cannot be released twice");
            }finally{pool.release();}
            check(nativeContext.getLong(pool)==0,"original native peer retired");
            pool.release();
            check(nativeContext.getLong(pool)==0,"repeated release retains no native peer");
            var owners=new java.util.ArrayList<WeakReference<Object>>();
            for(int i=0;i<16;i++){
                var released=new SoundPool.Builder().build();
                released.release();owners.add(new WeakReference<>(released));
            }
            until(services.loop,()->{System.gc();return owners.stream().allMatch(ref->ref.get()==null);},
                "native callbacks retain no released owners");
        }finally{Files.deleteIfExists(sampleFile);}
        System.out.println("PASS native references: original SoundPool decode, playback and release");
        System.exit(0);
    }
}
