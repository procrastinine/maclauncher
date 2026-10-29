public final class SyscallFixture {
    public static native int pid();
    public static native int borrowedBuffer(int[] value);
    public static native int readRetired(int address);
    public static native int bufferFinalizer();
}
