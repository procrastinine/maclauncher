package maclauncher.android;

import maclauncher.android.fixture.RuntimeFixture;
import maclauncher.android.framework.*;

/** Initial boot metadata arrives with the process authority. Settings itself
 * belongs to the profile system owner, which the process attaches before any
 * application code in production; reading this metadata starts no profile. */
public final class BootMetadataProbe {
    private static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        int status=0;var loop=RuntimeFixture.initialize(args[0],args[1]);
        try(var authority=ProcessAuthority.read(5,"org.example.window","org.example.window")){
            HostProcessIdentity.configure(authority.self.uid(),authority.self.hostUid());
            var bootCount=HostContext.class.getDeclaredMethod("hostBootCount");bootCount.setAccessible(true);
            check(Integer.valueOf(Integer.parseInt(args[2])).equals(bootCount.invoke(null)),"Authority boot metadata did not reach the process");
            System.out.println("PASS initial boot metadata precedes lazy profile attachment");
        }catch(Throwable failure){failure.printStackTrace();status=1;}
        finally{HostLooper.close(loop);}
        System.exit(status);
    }
}
