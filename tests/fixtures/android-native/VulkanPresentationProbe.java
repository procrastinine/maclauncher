public final class VulkanPresentationProbe {
    private static native void run(String adapter);
    public static void main(String[] args) {
        System.load(args[0]);
        run(args[1]);
        System.out.println("PASS original Vulkan WSI -> Android common presenter: rendered pixels and source resize");
    }
}
