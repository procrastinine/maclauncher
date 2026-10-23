public final class RegistrationOwnerProbe {
    public static final class Retained {static native int value();}
    public static final class Platform {static native int value();}
    public static final class Original {static native int value();static native int added();}
    private static native void initialize(String publisher);
    private static native void register(boolean original);
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){
        System.load(args[0]);initialize(args[1]);register(false);
        check(Retained.value()==17&&Platform.value()==23&&Original.value()==17,"initial native owners");
        register(true);
        check(Retained.value()==17,"publisher object binding retained");
        check(Platform.value()==23,"platform object binding retained");
        check(Original.value()==31&&Original.added()==31,"complete original table remains default");
        register(true);
        check(Retained.value()==17&&Platform.value()==23,"repeat registration preserves ownership");
        System.out.println("PASS complete original registration with exact retained representation tuples");
    }
}
