import maclauncher.android.media.MediaInputs;
public final class ArtMediaTransportProbe {
    static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] args)throws Exception{
        var devices=MediaInputs.class.getDeclaredMethod("nativeDevices");devices.setAccessible(true);
        String actual=(String)devices.invoke(null);check(actual.contains("audioInputs")&&actual.contains("cameraInputs"));
        try{MediaInputs.configure("missing-microphone-α-🌍","");throw new AssertionError();}catch(IllegalStateException expected){}
        MediaInputs.configure(null,null);
        check(!MediaInputs.isGranted("android.permission.RECORD_AUDIO")&&!MediaInputs.isGranted("android.permission.CAMERA"));
        check(MediaInputs.audioOpen(48000,1)==0&&!MediaInputs.audioStart(0));
        short[] samples={123,456,789};check(MediaInputs.audioRead(0,samples,1,1)==-3&&samples[0]==123&&samples[1]==456&&samples[2]==789);
        check(MediaInputs.audioRead(0,samples,2,2)==-2);
        check(MediaInputs.cameraSizes().length==0&&MediaInputs.cameraOpen()==0&&!MediaInputs.cameraStart(0,320,240));
        byte[] pixels={1,2,3};check(MediaInputs.cameraRead(0,pixels)==-1&&pixels[0]==1&&pixels[2]==3);check(MediaInputs.cameraRead(0,null)==-1);
        MediaInputs.audioStop(0);MediaInputs.audioClose(0);MediaInputs.cameraStop(0);MediaInputs.cameraClose(0);
        MediaInputs.hostShutdown();MediaInputs.hostShutdown();check(!MediaInputs.cameraSelected());
        try{MediaInputs.configure("","");throw new AssertionError();}catch(IllegalStateException expected){}
        System.out.println("PASS complete ART media JNI packet family, Unicode identity, exact arrays, failure retry and terminal retirement");
    }
}
