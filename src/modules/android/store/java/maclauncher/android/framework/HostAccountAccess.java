package maclauncher.android.framework;

import android.accounts.*;
import android.os.*;
import java.lang.reflect.*;
import java.util.*;

/** Launcher selection applies to consumers; original authenticators manage their own account types. */
public final class HostAccountAccess {
    private HostAccountAccess(){}
    private record Scope(HostBinderRpc.Peer peer,Account account,boolean network,Set<String> packages){}
    private record Invocation(Scope scope,String operation){}
    private static final Map<Integer,Scope> peers=new HashMap<>();
    private static final Map<Object,Invocation> sessions=new WeakHashMap<>();
    private static final ThreadLocal<Invocation> executing=new ThreadLocal<>();
    private static Scope local;
    private static final Set<String> MANAGEMENT=Set.of("addAccount","addAccountAsUser","addAccountExplicitly","addAccountExplicitlyWithVisibility",
        "startAddAccountSession","finishSessionAsUser","removeAccount","removeAccountAsUser","removeAccountExplicitly","renameAccount",
        "copyAccountToUser","updateCredentials","startUpdateCredentialsSession","editProperties");
    /** Anonymous app processes keep microG APIs but receive no shared accounts. */
    public static synchronized void anonymous(){local=new Scope(null,null,false,null);}
    public static synchronized void enroll(HostBinderRpc.Peer peer,Account selected,boolean network){enroll(peer,selected,network,null);}
    public static synchronized void enroll(HostBinderRpc.Peer peer,Account selected,boolean network,Set<String> packages){peers.put(peer.pid(),new Scope(peer,selected,network,packages==null?null:Set.copyOf(packages)));}
    /** The shared owner knows installed metadata needed for persistence, while
     * each authenticated caller retains its supervisor-selected package view. */
    static boolean packageVisible(String name,int uid){Scope scope=scope();return scope==null||scope.peer==null||scope.peer.uid()!=uid||scope.packages==null||scope.packages.contains(name);}
    public static synchronized void retire(HostBinderRpc.Peer peer){var scope=peers.get(peer.pid());if(scope!=null&&scope.peer.equals(peer))peers.remove(peer.pid());}
    private static synchronized Scope scope(){var peer=HostBinderRpc.callingPeer();if(peer==null)return local;var value=peers.get(peer.pid());return value!=null&&value.peer.equals(peer)?value:local;}
    private static Set<String> ownedTypes(IAccountManager original,Scope scope)throws RemoteException {
        if(scope==null||scope.peer==null)return Set.of();
        int user=UserHandle.getUserId(scope.peer.uid());Set<String> types=new HashSet<>();
        for(var provider:original.getAuthenticatorTypes(user))if(provider.packageName.equals(scope.peer.packageName())&&
            HostPackages.service().getPackageUid(provider.packageName,0,user)==scope.peer.uid())types.add(provider.type);
        return types;
    }
    static IAccountManager endpoint(IAccountManager original){
        return (IAccountManager)Proxy.newProxyInstance(IAccountManager.class.getClassLoader(),new Class<?>[]{IAccountManager.class},(proxy,method,args)->{
            if(method.getDeclaringClass()==Object.class)return switch(method.getName()){case "hashCode"->System.identityHashCode(proxy);case "equals"->proxy==args[0];case "toString"->"Android account access";default->throw new AssertionError(method);};
            if(method.getName().equals("asBinder"))return null;
            Scope scope=scope();Object[] values=args==null?new Object[0]:args.clone();
            Set<String> managed=ownedTypes(original,scope);
            boolean scoped=Arrays.stream(values).anyMatch(value->value instanceof Account account&&account.type.equals("com.google")||value instanceof String type&&type.equals("com.google")||value instanceof Bundle bundle&&"com.google".equals(bundle.getString(AccountManager.KEY_ACCOUNT_TYPE)));
            if(scope!=null){
                boolean forbidden=scoped&&MANAGEMENT.contains(method.getName())&&!managed.contains("com.google");
                for(Object value:values)if(value instanceof Account account&&account.type.equals("com.google")&&!managed.contains(account.type)&&!Objects.equals(account,scope.account))forbidden=true;
                if(forbidden){for(Object value:values)if(value instanceof IAccountManagerResponse response){response.onError(AccountManager.ERROR_CODE_CANCELED,"Account management is available in the launcher");return null;}return absent(method.getReturnType());}
                for(int i=0;i<values.length;i++)if(values[i] instanceof IAccountManagerResponse response)values[i]=new Response(response,scope,scoped&&!managed.contains("com.google"),managed);
            }
            Invocation previous=executing.get();if(scope!=null&&scoped)executing.set(new Invocation(scope,method.getName()));else executing.remove();
            try{Object result=method.invoke(original,values);return scope==null?result:filter(result,scope,managed);}
            catch(InvocationTargetException failure){throw failure.getCause();}
            finally{if(previous==null)executing.remove();else executing.set(previous);}
        });
    }
    private static Object absent(Class<?> type){
        if(type==boolean.class)return false;if(type==int.class)return 0;if(type==long.class)return 0L;
        if(type.isArray())return java.lang.reflect.Array.newInstance(type.componentType(),0);
        if(Map.class.isAssignableFrom(type))return Map.of();return null;
    }
    private static Object filter(Object value,Scope scope,Set<String> managed){
        if(value instanceof AuthenticatorDescription[] providers&&scope.packages!=null)return Arrays.stream(providers).filter(provider->scope.packages.contains(provider.packageName)).toArray(AuthenticatorDescription[]::new);
        if(value instanceof Account[] accounts)return Arrays.stream(accounts).filter(account->!account.type.equals("com.google")||managed.contains(account.type)||Objects.equals(account,scope.account)).toArray(Account[]::new);
        if(value instanceof Account account)return !account.type.equals("com.google")||managed.contains(account.type)||Objects.equals(account,scope.account)?account:null;
        if(value instanceof Map<?,?> map){var result=new LinkedHashMap<Object,Object>();for(var item:map.entrySet())if(!(item.getKey() instanceof Account account)||!account.type.equals("com.google")||managed.contains(account.type)||Objects.equals(account,scope.account))result.put(item.getKey(),item.getValue());return result;}
        return value;
    }
    private static final class Response extends IAccountManagerResponse.Stub {
        private final IAccountManagerResponse target;private final Scope scope;private final boolean interactiveRestricted;private final Set<String> managed;
        Response(IAccountManagerResponse target,Scope scope,boolean interactiveRestricted,Set<String> managed){this.target=target;this.scope=scope;this.interactiveRestricted=interactiveRestricted;this.managed=managed;}
        // The original service observes the actual caller Binder death. Filtering
        // a Java callback must not substitute a local Binder lifetime.
        @Override public IBinder asBinder(){return target.asBinder();}
        @Override public void onError(int code,String message)throws RemoteException{target.onError(code,message);}
        @Override public void onResult(Bundle result)throws RemoteException{
            if(result==null){target.onResult(null);return;}
            // Interactive account consent belongs to the explicit manager action.
            if(interactiveRestricted&&result.containsKey(AccountManager.KEY_INTENT)){
                var intent=result.getParcelable(AccountManager.KEY_INTENT,android.content.Intent.class);
                var authenticator=intent==null?null:intent.getParcelableExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE,AccountAuthenticatorResponse.class);
                if(authenticator!=null)authenticator.onError(AccountManager.ERROR_CODE_CANCELED,"Account interaction is available in the launcher");else target.onError(AccountManager.ERROR_CODE_CANCELED,"Account interaction is available in the launcher");return;
            }
            Bundle copy=new Bundle(result);
            if(copy.containsKey(AccountManager.KEY_ACCOUNTS)){
                Parcelable[] values=copy.getParcelableArray(AccountManager.KEY_ACCOUNTS);
                copy.putParcelableArray(AccountManager.KEY_ACCOUNTS,values==null?null:Arrays.stream(values).filter(value->value instanceof Account account&&(!account.type.equals("com.google")||managed.contains(account.type)||Objects.equals(account,scope.account))).toArray(Account[]::new));
            }
            String name=copy.getString(AccountManager.KEY_ACCOUNT_NAME),type=copy.getString(AccountManager.KEY_ACCOUNT_TYPE);
            if(name!=null&&"com.google".equals(type)&&!managed.contains(type)&&(scope.account==null||!name.equals(scope.account.name)||type!=null&&!type.equals(scope.account.type))){target.onError(AccountManager.ERROR_CODE_CANCELED,"The requested account is not selected");return;}
            target.onResult(copy);
        }
    }
    /** Original Session lifetime retains its originating request after Binder identity clears. */
    public static void createdSession(Object session){Invocation call=executing.get();if(call!=null)synchronized(sessions){sessions.put(session,call);}}
    public static void retiredSession(Object session){synchronized(sessions){sessions.remove(session);}}
    public static boolean bindSession(Object session)throws RemoteException{
        Invocation call;synchronized(sessions){call=sessions.get(session);}
        // AccountManager has already returned its original cached-token result
        // before constructing this session. Only an actual cache miss reaches here.
        if(call!=null&&!call.scope.network){
            ((IAccountAuthenticatorResponse)session).onError(AccountManager.ERROR_CODE_NETWORK_ERROR,"Network access is disabled");return false;
        }
        return true;
    }
}
