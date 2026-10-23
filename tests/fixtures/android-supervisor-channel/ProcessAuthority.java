package maclauncher.android;

import java.nio.charset.StandardCharsets;

/** An isolated JNI receiver fixture; no Android application or framework substitute. */
public final class ProcessAuthority {
    private record Packet(byte[] bytes,int fd){}
    private static native Packet receiveNative(int descriptor);
    private static native int fixtureNative(boolean brokenReceipt);
    private static native void checkDataNative(int descriptor);
    private static native void checkReceiptNative(boolean brokenReceipt);
    private static native void closeFixtureNative(int descriptor);
    public static void main(String[] args){
        System.load(args[0]);
        for(boolean broken:new boolean[]{false,true}){
            int channel=fixtureNative(broken);
            try{
                Packet first=receiveNative(channel);
                if(first==null||first.fd<0||!new String(first.bytes,StandardCharsets.UTF_8).equals("{\"op\":\"connect\"}"))
                    throw new AssertionError("Transferred connection was not adopted");
                checkDataNative(first.fd);
                checkReceiptNative(broken);
                Packet next=receiveNative(channel);
                if(next==null||next.fd!=-1||!new String(next.bytes,StandardCharsets.UTF_8).equals("{\"op\":\"next\"}"))
                    throw new AssertionError("Receipt lifetime retired the parent authority channel");
            }finally{closeFixtureNative(channel);}
        }
        System.out.println("Connection receipts preserve their parent authority channel");
    }
}
