package loader.fixture;
public final class Agent {
 public static volatile String status;
 public static java.lang.instrument.Instrumentation instrumentation;
 public static void premain(String args,java.lang.instrument.Instrumentation value){instrumentation=value;status="ready";}
}
