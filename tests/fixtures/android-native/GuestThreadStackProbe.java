public final class GuestThreadStackProbe {
    private static native void run(String runtime);
    public static void main(String[] arguments) {
        System.load(arguments[0]);
        run(arguments[1]);
        System.out.println("PASS guest native stack reserves support JVM attachment and startup handshakes");
    }
}
