package maclauncher.android.framework;

import android.accounts.*;
import android.os.*;
import java.nio.file.*;
import java.util.*;
import maclauncher.android.fixture.RuntimeFixture;

/** Account sharing policy below the original complete account AIDL contract. */
public final class AccountSelectionProbe {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    public static void main(String[] args)throws Exception{
        Looper loop=RuntimeFixture.initialize(args[0],args[1]);
        Account one=new Account("selected","com.google"),two=new Account("other","com.google"),local=new Account("game","org.example.accounts");
        int[] requests={0};
        IAccountManager original=new IAccountManager.Default(){
            @Override public Account[] getAccountsAsUser(String type,int user,String pkg){requests[0]++;return new Account[]{one,two,local};}
            @Override public boolean addAccountExplicitly(Account account,String password,Bundle extra,String pkg){requests[0]++;return true;}
            @Override public void getAccountsByFeatures(IAccountManagerResponse response,String type,String[] features,String pkg)throws RemoteException{Bundle reply=new Bundle();reply.putParcelableArray(AccountManager.KEY_ACCOUNTS,new Account[]{one,two,local});response.onResult(reply);}
        };
        try{
            IAccountManager scoped=HostAccountAccess.endpoint(original);HostAccountAccess.anonymous();
            check(Arrays.equals(scoped.getAccountsAsUser(null,0,"fixture"),new Account[]{local}),"anonymous Google mode preserves unrelated Android accounts");
            check(!scoped.addAccountExplicitly(one,"unused",Bundle.EMPTY,"fixture")&&requests[0]==1,"game cannot create shared Google accounts");
            check(scoped.addAccountExplicitly(local,"unused",Bundle.EMPTY,"fixture"),"unrelated authenticator uses original service");
            Class<?> type=Class.forName("maclauncher.android.framework.HostAccountAccess$Scope");var constructor=type.getDeclaredConstructors()[0];constructor.setAccessible(true);
            var field=HostAccountAccess.class.getDeclaredField("local");field.setAccessible(true);field.set(null,constructor.newInstance(null,one,true));
            check(Arrays.equals(scoped.getAccountsAsUser(null,0,"fixture"),new Account[]{one,local}),"only selected shared Google account is visible");
            scoped.getAccountsByFeatures(new IAccountManagerResponse.Stub(){
                @Override public void onError(int code,String message){throw new AssertionError(code);}
                @Override public void onResult(Bundle result){check(Arrays.equals(result.getParcelableArray(AccountManager.KEY_ACCOUNTS),new Account[]{one,local}),"asynchronous original response preserves selection");}
            },"com.google",new String[0],"fixture");
            field.set(null,null);check(scoped.getAccountsAsUser(null,0,"fixture").length==3,"explicit account manager retains full original inventory");
            System.out.println("PASS account selection: anonymous, selected, original callbacks and unrelated authenticators");
        }finally{HostLooper.close(loop);HostContext.hostShutdown();}
    }
}
