package loader.fixture;
public final class ApplicationHandler extends java.util.logging.Handler {
 public static int messages;
 public void publish(java.util.logging.LogRecord record){messages++;}
 public void flush(){}
 public void close(){}
 public static Class<?> agentIdentity(){return Agent.class;}
}
