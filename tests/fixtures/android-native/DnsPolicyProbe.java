package maclauncher.android.net;

import android.system.*;
import java.net.*;
import java.net.spi.*;
import java.util.*;
import java.util.stream.Stream;
import libcore.io.Libcore;

/** Offline checks of the resolver SPI and original libcore native DNS boundary. */
public final class DnsPolicyProbe {
    private static native int resolutions();
    private static void check(boolean value,String reason){if(!value)throw new AssertionError(reason);}
    private static final class Builtin implements InetAddressResolver {
        String name;LookupPolicy policy;byte[] reverse;Stream<InetAddress> result;UnknownHostException failure;int calls;
        @Override public Stream<InetAddress> lookupByName(String host,LookupPolicy requested)throws UnknownHostException{
            calls++;name=host;policy=requested;if(failure!=null)throw failure;return result;
        }
        @Override public String lookupByAddress(byte[] address){reverse=address;return "reverse.invalid";}
    }
    private static void nativeNumeric(String host,int family,Class<?> type)throws Exception{
        StructAddrinfo hints=new StructAddrinfo();hints.ai_flags=OsConstants.AI_NUMERICHOST;hints.ai_family=family;hints.ai_socktype=OsConstants.SOCK_STREAM;
        int before=resolutions();InetAddress[] values=Libcore.rawOs.android_getaddrinfo(host,hints,0);
        check(resolutions()==before+1&&values.length>0,"numeric lookup must use the actual native resolver");
        for(InetAddress value:values)check(type.isInstance(value)&&value.isLoopbackAddress(),"native address family and bytes must survive conversion");
    }
    public static void main(String[] args)throws Exception{
        System.load(args[0]);boolean allow=Boolean.parseBoolean(args[1]);Builtin builtin=new Builtin();
        // Configuration is sealed in Java 21; use the JDK's actual configuration
        // with an offline delegate instead of adding a production test seam.
        var configuration=(InetAddressResolverProvider.Configuration)Class.forName("sun.net.ResolverProviderConfiguration")
            .getConstructor(InetAddressResolver.class,java.util.function.Supplier.class)
            .newInstance(builtin,(java.util.function.Supplier<String>)()->"local.invalid");
        InetAddressResolver resolver=new HostInetAddressResolverProvider().get(configuration);
        var policy=InetAddressResolver.LookupPolicy.of(InetAddressResolver.LookupPolicy.IPV4|InetAddressResolver.LookupPolicy.IPV6|InetAddressResolver.LookupPolicy.IPV6_FIRST);
        InetAddress first=InetAddress.getByAddress(new byte[]{127,0,0,1}),second=InetAddress.getByAddress(new byte[]{127,0,0,2});
        builtin.result=Stream.of(first);check(resolver.lookupByName("doubleclick.net",policy)==builtin.result,"JVM bootstrap must retain its ordinary resolver before session configuration");builtin.result.close();
        HostNetworkPolicy.configure(allow);
        int[] closed={0};builtin.result=Stream.of(first,second).onClose(()->closed[0]++);String host=new String("allowed.example.invalid");
        Stream<InetAddress> result=resolver.lookupByName(host,policy);
        check(result==builtin.result&&builtin.name==host&&builtin.policy==policy,"allowed requests must preserve the exact stream, host and lookup policy");
        try(result){check(result.toList().equals(List.of(first,second)),"built-in address ordering must be preserved");}
        check(closed[0]==1,"caller stream closure must reach the built-in resolver");
        byte[] reverse={127,0,0,1};check(resolver.lookupByAddress(reverse).equals("reverse.invalid")&&builtin.reverse==reverse,"reverse lookup must delegate the original address unchanged");
        builtin.failure=new UnknownHostException("resolver fixture");
        try{resolver.lookupByName("failure.invalid",policy);throw new AssertionError("delegate error lost");}catch(UnknownHostException expected){check(expected==builtin.failure,"delegate exception identity must be preserved");}builtin.failure=null;
        for(String benign:new String[]{"xn--bcher-kva.example","bücher.example"}){
            builtin.result=Stream.of(first);try(Stream<InetAddress> ignored=resolver.lookupByName(benign,policy)){check(builtin.name==benign,"IDN policy matching must preserve the original host for the built-in resolver");}
        }
        builtin.failure=new UnknownHostException("invalid hostname fixture");
        try{resolver.lookupByName("invalid..example",policy);throw new AssertionError("invalid IDN lost its resolver error");}
        catch(UnknownHostException expected){check(expected==builtin.failure,"invalid IDN text must reach the built-in resolver's error path");}builtin.failure=null;
        for(String blocked:new String[]{"doubleclick.net","Ads.DoubleClick.Net.","ads.doubleclick。net","ＤＯＵＢＬＥＣＬＩＣＫ．ＮＥＴ"}){
            int before=builtin.calls;builtin.result=Stream.of(first);
            try(Stream<InetAddress> ignored=resolver.lookupByName(blocked,policy)){check(allow&&builtin.name==blocked,"allowed IDN host must reach the built-in resolver unchanged");}
            catch(UnknownHostException denied){check(!allow,"allow-ad session unexpectedly rejected the host");}
            check(builtin.calls==before+(allow?1:0),"blocked names must not call the built-in resolver");
        }
        check(ServiceLoader.load(InetAddressResolverProvider.class).findFirst().orElseThrow().getClass()==HostInetAddressResolverProvider.class,"provider service metadata must select the owned resolver");
        if(!allow)try{InetAddress.getAllByName("doubleclick.net");throw new AssertionError("java.net bypassed the session policy");}catch(UnknownHostException expected){}
        check(InetAddress.getByName("127.0.0.1").isLoopbackAddress(),"numeric java.net addresses must remain available");
        nativeNumeric("127.0.0.1",OsConstants.AF_INET,Inet4Address.class);
        nativeNumeric("::1",OsConstants.AF_INET6,Inet6Address.class);
        StructAddrinfo hints=new StructAddrinfo();hints.ai_flags=OsConstants.AI_NUMERICHOST;hints.ai_family=OsConstants.AF_UNSPEC;hints.ai_socktype=OsConstants.SOCK_STREAM;
        int before=resolutions();
        try{Libcore.rawOs.android_getaddrinfo("doubleclick.net",hints,0);throw new AssertionError("nonnumeric host resolved with AI_NUMERICHOST");}
        catch(GaiException expected){check(expected.error==OsConstants.EAI_NONAME,"DNS rejection must keep original GaiException semantics");check(expected.getMessage()!=null,"native gai_strerror must describe original errors");}
        check(resolutions()==before+(allow?1:0),"native policy must reject blocked hosts before getaddrinfo; override still preserves numeric-only hints");
        hints.ai_flags=0x40000000;
        try{Libcore.rawOs.android_getaddrinfo("127.0.0.1",hints,0);throw new AssertionError("unsupported address flags accepted");}
        catch(GaiException expected){check(expected.error==OsConstants.EAI_BADFLAGS,"Android address hint errors must be preserved");}
        check(resolutions()==before+(allow?1:0),"invalid flags must not enter the platform resolver");
        System.out.println("PASS Android DNS SPI, original libcore policy, numeric IPv4/IPv6 and allowAds="+allow);
    }
}
