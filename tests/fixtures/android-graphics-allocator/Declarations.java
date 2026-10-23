import android.os.Binder;
import maclauncher.android.framework.HostServices;
import maclauncher.android.fixture.RuntimeFixture;
import java.util.Arrays;
public final class Declarations {
    private static void check(boolean value){if(!value)throw new AssertionError();}
    public static void main(String[] arguments)throws Exception {
        RuntimeFixture.initialize(arguments[0],arguments[1]);
        var local=HostServices.manager();var published=HostServices.publishedManager();
        var declaration=HostServices.declareService("mapper/fixture");
        check(local.isDeclared("mapper/fixture")&&published.isDeclared("mapper/fixture"));
        check(local.checkService("mapper/fixture")==null&&published.checkService("mapper/fixture")==null);
        check(Arrays.asList(published.getDeclaredInstances("mapper")).contains("fixture"));
        check(!Arrays.asList(published.listServices(0)).contains("mapper/fixture"));
        Binder endpoint=new Binder("fixture");local.addService("mapper/fixture",endpoint,false,0);
        check(published.checkService("mapper/fixture")==endpoint);
        local.tryUnregisterService("mapper/fixture",endpoint);
        check(published.isDeclared("mapper/fixture")&&published.checkService("mapper/fixture")==null);
        declaration.close();check(!published.isDeclared("mapper/fixture"));
        var next=HostServices.declareService("mapper/fixture");declaration.close();check(published.isDeclared("mapper/fixture"));next.close();
        var localBinder=new Binder("local.fixture");android.os.IInterface untouched=()->localBinder;localBinder.attachInterface(untouched,"local.fixture");HostServices.register("local.fixture",untouched,"local.fixture");
        check(local.checkService("local.fixture")!=null&&published.checkService("local.fixture")==null);
        var localDeclaration=HostServices.declareService("local.fixture");
        check(published.isDeclared("local.fixture")&&published.checkService("local.fixture")==null);
        check(!Arrays.asList(published.listServices(0)).contains("local.fixture"));
        localDeclaration.close();check(!published.isDeclared("local.fixture"));
        check(local.checkService("local.fixture")!=null);
        HostServices.unregister("local.fixture",untouched,"local.fixture");
        var before=HostServices.declareService("local.later");
        HostServices.register("local.later",untouched,"local.fixture");
        check(published.isDeclared("local.later")&&published.checkService("local.later")==null);
        HostServices.unregister("local.later",untouched,"local.fixture");
        check(published.isDeclared("local.later"));before.close();
        System.out.println("PASS declaration-only HAL discovery and shared service lifetime");
    }
}
