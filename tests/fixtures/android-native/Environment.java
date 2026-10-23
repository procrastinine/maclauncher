package maclauncher.android.tests;
import android.system.Os;
import android.system.ErrnoException;
public final class Environment {
    static int checks;
    static void check(boolean value){checks++;if(!value)throw new AssertionError("environment check "+checks);}
    public static void main(String[] arguments)throws Exception{
        String key="MACLAUNCHER_NATIVE_ENV_TEST_"+ProcessHandle.current().pid();
        try{
            Os.unsetenv(key);check(Os.getenv(key)==null);
            Os.setenv(key,"héllo😀",false);check("héllo😀".equals(Os.getenv(key)));
            check(java.util.Arrays.asList(Os.environ()).contains(key+"=héllo😀"));
            Os.setenv(key,"ignored",false);check("héllo😀".equals(Os.getenv(key)));
            Os.setenv(key,"replaced",true);check("replaced".equals(Os.getenv(key)));
            Os.setenv(key,"",true);check("".equals(Os.getenv(key)));
            for(String invalid:new String[]{"","x=y"}){try{Os.setenv(invalid,"x",true);throw new AssertionError();}catch(ErrnoException error){check(error.errno==22);}}
            try{Os.setenv("x\0y","x",true);throw new AssertionError();}catch(IllegalArgumentException expected){check(true);}
            try{Os.setenv(key,"x\0y",true);throw new AssertionError();}catch(IllegalArgumentException expected){check(true);}
            check("".equals(Os.getenv(key)));
            for(int i=0;i<1000;i++){Os.setenv(key,Integer.toString(i),true);check(Integer.toString(i).equals(Os.getenv(key)));}
        }finally{Os.unsetenv(key);}
        check(Os.getenv(key)==null);
        System.out.println("Original libcore environment checks="+checks);
    }
}
