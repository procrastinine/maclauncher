public final class RegistrationOwnerProbe {
    public static final class Retained {static native int value();static native int omitted();}
    public static final class Platform {static int value(){return 37;}}
    public static final class NativePlatform {static native int value();}
    public static final class Original {static native int value();static native int added();}
    private static native void initialize(String publisher);
    private static native void register(boolean original);
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args){
        System.load(args[0]);initialize(args[1]);register(false);
        check(Retained.value()==17&&Platform.value()==37&&NativePlatform.value()==23&&Original.value()==17,"initial native owners");
        check(Retained.omitted()==47,"concrete native implementation fills an omitted publisher table row");
        register(true);
        check(Retained.value()==17,"publisher object binding retained");
        check(Platform.value()==37&&NativePlatform.value()==23,"exact Java and native platform implementations retained");
        check(Original.value()==31&&Original.added()==31,"complete original table remains default");
        register(true);
        check(Retained.value()==17&&Retained.omitted()==47&&Platform.value()==37&&NativePlatform.value()==23,"repeat registration preserves ownership");
        System.out.println("PASS complete original registration with exact retained representation tuples");
    }
}
