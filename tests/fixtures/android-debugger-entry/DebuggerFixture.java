import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import sun.misc.Unsafe;

public final class DebuggerFixture {
    private static void waitFor(String file) throws Exception {
        long until = System.nanoTime() + 20_000_000_000L;
        while (!Files.exists(Path.of(file))) {
            if (System.nanoTime() > until) throw new IllegalStateException("Fixture gate deadline");
            Thread.sleep(10);
        }
    }
    public static void main(String[] args) throws Exception {
        Field field = Unsafe.class.getDeclaredField("theUnsafe");
        field.setAccessible(true);
        Unsafe memory = (Unsafe) field.get(null);
        long address = memory.allocateMemory(8);
        try {
            memory.putLong(address, 0);
            System.out.printf("READY %d 0x%x%n", ProcessHandle.current().pid(), address);
            System.out.flush();
            waitFor(args[0]);
            memory.putLong(address, 0x20ea710L);
            long actual = memory.getLong(address);
            System.out.printf("RESULT 0x%x%n", actual);
            System.out.flush();
            if (actual != 0x20ea710L) throw new AssertionError("Original store changed");
            waitFor(args[1]);
        } finally { memory.freeMemory(address); }
    }
}
