package maclauncher.android;

import android.content.*;
import android.media.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.framework.*;
import maclauncher.android.fixture.MediaServicesFixture;

public final class AudioPolicyProbe {
    private static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    public static void main(String[] args){try{run(args);}catch(Throwable failure){failure.printStackTrace();System.exit(1);}}
    private static void run(String[] args)throws Exception{
        Path runtime=Path.of(args[0]),data=Path.of(args[1]);
        try(var services=new MediaServicesFixture(runtime,data)){
        Looper loop=services.loop;Context context=services.context;
        AudioManager audio=context.getSystemService(AudioManager.class);
        List<Integer> events=new ArrayList<>();
        AudioManager.OnAudioFocusChangeListener first=events::add,second=ignored->{};
        check(audio.requestAudioFocus(first,AudioManager.STREAM_MUSIC,AudioManager.AUDIOFOCUS_GAIN)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED,"first original focus request");
        check(audio.requestAudioFocus(second,AudioManager.STREAM_MUSIC,AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED,"temporary original focus request");
        HostLooper.drain(loop);check(events.equals(List.of(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)),"original focus loss callback");
        check(audio.abandonAudioFocus(second)==AudioManager.AUDIOFOCUS_REQUEST_GRANTED,"original temporary abandon");
        HostLooper.drain(loop);check(events.equals(List.of(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,AudioManager.AUDIOFOCUS_GAIN)),"original focus owner restored");
        audio.abandonAudioFocus(first);
        IAudioService service=IAudioService.Stub.asInterface(ServiceManager.getService("audio"));
        check(service.getCurrentAudioFocus()==AudioManager.AUDIOFOCUS_NONE,"focus stack empty after abandon");
        Binder playerBinder=new Binder();
        IPlayer player=new IPlayer.Default(){@Override public IBinder asBinder(){return playerBinder;}};
        playerBinder.attachInterface(player,"android.media.IPlayer");
        var constructor=PlayerBase.PlayerIdCard.class.getDeclaredConstructor(int.class,AudioAttributes.class,IPlayer.class,int.class);constructor.setAccessible(true);
        var attributes=new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).build();
        var card=constructor.newInstance(AudioPlaybackConfiguration.PLAYER_TYPE_JAM_AUDIOTRACK,attributes,player,73);
        List<List<AudioPlaybackConfiguration>> playback=new ArrayList<>();
        IPlaybackConfigDispatcher callback=new IPlaybackConfigDispatcher.Stub(){public void dispatchPlaybackConfigChange(List<AudioPlaybackConfiguration> values,boolean flush){playback.add(values);}};
        service.registerPlaybackCallback(callback);
        int id=service.trackPlayer(card);check(id>0,"original player registration uses native unique identity");
        service.playerEvent(id,AudioPlaybackConfiguration.PLAYER_STATE_STARTED,new int[0]);
        check(service.getActivePlaybackConfigurations().stream().anyMatch(p->p.getPlayerInterfaceId()==id&&p.isActive()&&p.getSessionId()==73),"upstream playback metadata");
        check(!playback.isEmpty(),"upstream playback callback dispatch");
        service.playerEvent(id,AudioPlaybackConfiguration.PLAYER_UPDATE_PORT_ID,new int[]{42});
        var format=new PersistableBundle();format.putInt(AudioPlaybackConfiguration.EXTRA_PLAYER_EVENT_SAMPLE_RATE,48000);
        format.putInt(AudioPlaybackConfiguration.EXTRA_PLAYER_EVENT_CHANNEL_MASK,3);
        service.portEvent(42,AudioPlaybackConfiguration.PLAYER_UPDATE_FORMAT,format);
        long deadline=System.nanoTime()+2_000_000_000L;AudioPlaybackConfiguration updated;
        do{updated=service.getActivePlaybackConfigurations().stream().filter(p->p.getPlayerInterfaceId()==id).findFirst().orElseThrow();if(updated.getSampleRate()==48000)break;Thread.sleep(5);}while(System.nanoTime()<deadline);
        check(updated.getSampleRate()==48000&&updated.getChannelMask()==AudioFormat.CHANNEL_OUT_STEREO,"original native port event updates player format");
        service.releasePlayer(id);check(service.getActivePlaybackConfigurations().isEmpty(),"upstream player release");
        service.unregisterPlaybackCallback(callback);
        }
        check(ServiceManager.checkService("audio")==null,"profile audio service unpublished");
        System.out.println("PASS original audio focus transfer, restore, playback callbacks and profile retirement");
        System.exit(0);
    }
}
