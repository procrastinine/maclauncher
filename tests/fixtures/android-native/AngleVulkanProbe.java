public final class AngleVulkanProbe {
    private static native void run();
    public static void main(String[] args) {
        System.load(args[0]);
        run();
        System.out.println("PASS ANGLE Vulkan: GLES compute and native-layer GPU presentation");
    }
}
