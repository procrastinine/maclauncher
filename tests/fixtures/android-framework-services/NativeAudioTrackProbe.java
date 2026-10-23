import android.media.*;
import android.os.*;
import java.nio.*;
import java.nio.file.*;
import java.lang.reflect.*;
import maclauncher.android.framework.*;
import maclauncher.android.media.*;
import maclauncher.android.fixture.MediaServicesFixture;

/** Original AudioTrack clients, actual CoreAudio PCM consumption and deterministic lifetime. */
public final class NativeAudioTrackProbe {
    private static native long[] audioSnapshot();
    private static native int playAaudio(String library);
    private static void check(boolean value,String text){if(!value)throw new AssertionError(text);}
    public static void main(String[] args)throws Exception {
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);
        if(args.length>2)System.load(Path.of(args[2]).toAbsolutePath().toString());
        try(var services=new MediaServicesFixture(runtime,data)){
        Looper loop=services.loop;AudioManager manager=services.context.getSystemService(AudioManager.class);
        check(!manager.isMusicActive()&&!manager.isMusicActiveRemotely(),"idle local and remote audio queries");
        manager.setNavigationRepeatSoundEffectsEnabled(true);manager.setHomeSoundEffectEnabled(true);
        check(manager.areNavigationRepeatSoundEffectsEnabled()&&manager.isHomeSoundEffectEnabled(),"original UI sound configuration reaches service");
        manager.setNavigationRepeatSoundEffectsEnabled(false);manager.setHomeSoundEffectEnabled(false);
        int minimum=AudioTrack.getMinBufferSize(48000,AudioFormat.CHANNEL_OUT_STEREO,AudioFormat.ENCODING_PCM_16BIT);
        check(minimum>0,"FMOD minimum buffer query");
        AudioTrack track=new AudioTrack(AudioManager.STREAM_MUSIC,48000,AudioFormat.CHANNEL_OUT_STEREO,AudioFormat.ENCODING_PCM_16BIT,minimum*2,AudioTrack.MODE_STREAM);
        check(track.getState()==AudioTrack.STATE_INITIALIZED,"original constructor reaches actual native output");
        short[] pcm=new short[minimum];for(int i=0;i<pcm.length;i++)pcm[i]=(short)Math.round(1024*Math.sin(2*Math.PI*440*(i/2)/48000.0));
        check(track.write(pcm,0,pcm.length,AudioTrack.WRITE_NON_BLOCKING)>0,"Nonzero PCM ring accepts nonblocking samples before Play");
        track.play();check(track.write(pcm,0,pcm.length)==pcm.length,"blocking stream feeds real output");
        check(manager.isMusicActive()&&AudioSystem.isStreamActive(AudioManager.STREAM_MUSIC,0),"original audio clients observe active playback");
        long deadline=System.nanoTime()+2_000_000_000L;while(track.getPlaybackHeadPosition()==0&&System.nanoTime()<deadline)Thread.sleep(5);
        check(track.getPlaybackHeadPosition()>0,"CoreAudio consumed PCM frames");
        if(args.length>2){long[] output=audioSnapshot();deadline=System.nanoTime()+2_000_000_000L;while(output[3]==0&&System.nanoTime()<deadline){Thread.sleep(5);output=audioSnapshot();}
            check(output[0]>0&&output[1]>0&&output[2]>0&&output[3]>0&&output[4]>0,"Actual output AudioUnit ran and rendered nonzero PCM");
            check(output[10]==0,"Nonzero output buffers are not discarded by a silence flag");
            check(output[5]>0&&output[8]!=0&&output[9]>0,"Actual hardware output device is running at its observed rate");
            System.out.println("AUDIO_OUTPUT created,started,callbacks,nonzero,peakMillion,device,mute,volumeMillion,running,rate,nonzeroMarkedSilent="+java.util.Arrays.toString(output));
        }
        track.pause();check(!manager.isMusicActive(),"pause clears current music activity");
        check(AudioSystem.isStreamActive(AudioManager.STREAM_MUSIC,1000),"recent music activity survives pause");
        track.flush();check(track.getPlaybackHeadPosition()==0,"flush resets position");track.release();
        Field field=AudioTrack.class.getDeclaredField("mNativeTrackInJavaObj");field.setAccessible(true);check(field.getLong(track)==0,"release retires the original native peer");
        AudioTrack floats=new AudioTrack.Builder().setAudioFormat(new AudioFormat.Builder().setSampleRate(44100).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_FLOAT).build()).setBufferSizeInBytes(4096).setTransferMode(AudioTrack.MODE_STATIC).build();
        check(floats.write(new float[258],1,256,AudioTrack.WRITE_NON_BLOCKING)==256,"float offset is a sample offset");
        java.util.concurrent.atomic.AtomicInteger markers=new java.util.concurrent.atomic.AtomicInteger();
        floats.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener(){
            public void onMarkerReached(AudioTrack source){check(Looper.myLooper()==loop,"marker retains original callback Looper");markers.incrementAndGet();}
            public void onPeriodicNotification(AudioTrack source){}
        },new Handler(loop));
        check(floats.setNotificationMarkerPosition(384)==AudioTrack.SUCCESS,"marker at the final consumed source frame");
        check(floats.setLoopPoints(0,128,1)==0,"static buffer loop");floats.play();
        deadline=System.nanoTime()+2_000_000_000L;
        while(markers.get()==0&&System.nanoTime()<deadline){HostLooper.drain(loop);Thread.sleep(5);}
        check(floats.getPlaybackHeadPosition()==384,"static loop consumes exactly 256 original frames plus the repeated 128");
        check(markers.get()==1,"final marker is delivered after Java has finished feeding the native queue");
        floats.stop();floats.release();HostLooper.drain(loop);
        if(args.length>2){long before=audioSnapshot()[3];check(playAaudio(runtime.resolve("native/libklepton-jvm.dylib").toRealPath().toString())==9600,"Original AAudio guest import accepts all nonzero PCM frames");
            long[] output=audioSnapshot();check(output[3]>before,"AAudio PCM reached the actual output callback too");System.out.println("AAUDIO_OUTPUT nonzero callbacks="+(output[3]-before)+" peakMillion="+output[4]);
        }
        MediaPlayer player=new MediaPlayer();player.addOnRoutingChangedListener((AudioRouting.OnRoutingChangedListener)ignored->{},new Handler(loop));
        player.release();
        }
        System.out.println("PASS original AudioTrack PCM writes, consumption, static loops, MediaPlayer routing and release");
        System.exit(0);
    }
}
