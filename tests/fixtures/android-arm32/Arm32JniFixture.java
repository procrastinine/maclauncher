public final class Arm32JniFixture {
    public int value;
    public Arm32JniFixture(int value) { this.value = value; }
    public static long mixed(long value, float single, double wide, int tail) {
        if (single != 1.25f || wide != 3.5 || tail != 17) throw new AssertionError("AAPCS arguments");
        return value + 19;
    }
    public static native long nativeRoundtrip(long value, float single, double wide, String text, int[] values);
    public static java.nio.FloatBuffer floats() {
        return java.nio.ByteBuffer.allocateDirect(20).order(java.nio.ByteOrder.nativeOrder())
            .asFloatBuffer().put(new float[] {1, 2, 3, 4, 40}).flip();
    }
    public static long invokeNative() {
        return nativeRoundtrip(0x123456789abcdef0L, 1.25f, 3.5, "callback", new int[] {7, 11});
    }
}
