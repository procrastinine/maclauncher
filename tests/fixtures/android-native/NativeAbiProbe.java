package probe;
public final class NativeAbiProbe {
    static {System.load(System.getProperty("klepton.abi.test"));}
    private static native void bind(String name,String descriptor,int stackWords);
    private static native long[] capture();
    private static native void grow();
    private static native long integers(int a,int b,int c,int d,int e,int f,int g,int h);
    private static native long narrow(int a,int b,int c,int d,int e,int f,byte g,char h,short i,boolean j,long k,int l);
    private static native long floating(float a,float b,float c,float d,float e,float f,float g,float h,float i,float j,int k,int l);
    private static native long mixed(int a,int b,int c,int d,int e,int f,double g,double h,double i,double j,double k,double l,double m,double n,float o,int p,double q,byte r);
    private static native float resultFloat(float value,int a,int b,int c,int d,int e,int f,int g,int h);
    private static native double resultDouble(double value,int a,int b,int c,int d,int e,int f,int g,int h);
    private static void equal(long expected,long actual){if(expected!=actual)throw new AssertionError("ABI value: expected "+Long.toHexString(expected)+" got "+Long.toHexString(actual));}
    private static void result(long value){equal(0x789,value);}
    public static void main(String[] args){
        grow(); // Existing calling-convention checks now execute beyond three remapped pages.
        bind("integers","(IIIIIIII)J",2);result(integers(11,12,13,14,15,16,17,18));long[] got=capture();for(int i=0;i<6;i++)equal(i+11,got[i+2]);equal(17,got[16]);equal(18,got[17]);
        bind("narrow","(IIIIIIBCSZJI)J",6);result(narrow(1,2,3,4,5,6,(byte)-7,'\uabcd',(short)-1234,true,0x123456789abcdef0L,-91));got=capture();
        equal(0xf9,got[16]);equal(0xabcd,got[17]);equal(0xfb2e,got[18]);equal(1,got[19]);equal(0x123456789abcdef0L,got[20]);equal(0xffffffa5L,got[21]);
        bind("floating","(FFFFFFFFFFII)J",2);result(floating(.25f,.5f,.75f,1f,1.25f,1.5f,1.75f,2f,2.25f,2.5f,31,32));got=capture();
        for(int i=0;i<8;i++)equal(Float.floatToRawIntBits((i+1)*.25f)&0xffffffffL,got[8+i]&0xffffffffL);equal(Float.floatToRawIntBits(2.25f),got[16]);equal(Float.floatToRawIntBits(2.5f),got[17]);equal(31,got[2]);equal(32,got[3]);
        bind("mixed","(IIIIIIDDDDDDDDFIDB)J",4);result(mixed(1,2,3,4,5,6,1,2,3,4,5,6,7,8,9.25f,37,10.5,(byte)-12));got=capture();
        for(int i=0;i<8;i++)equal(Double.doubleToRawLongBits(i+1),got[8+i]);equal(Float.floatToRawIntBits(9.25f),got[16]);equal(37,got[17]);equal(Double.doubleToRawLongBits(10.5),got[18]);equal(0xf4,got[19]);
        bind("resultFloat","(FIIIIIIII)F",2);if(resultFloat(.625f,1,2,3,4,5,6,7,8)!=.625f)throw new AssertionError("Float return register changed");
        bind("resultDouble","(DIIIIIIII)D",2);if(resultDouble(13.75,1,2,3,4,5,6,7,8)!=13.75)throw new AssertionError("Double return register changed");
        System.out.println("PASS actual HotSpot JNI -> AAPCS64: integer spill, byte/char/short/bool widths, aligned long, FP spill, mixed stack order, preserved integer/FP registers and return value");
    }
}
