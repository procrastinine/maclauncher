package maclauncher.android.tests;

import android.content.Context;
import android.hardware.usb.UsbManager;
import android.bluetooth.BluetoothManager;

/** Complete original API descriptors remain accessible even without a device service. */
public final class OptionalHardware {
    public static void run(Context context)throws Exception{
        for(String name:new String[]{"android.hardware.usb.UsbDevice","android.hardware.usb.UsbInterface","android.hardware.usb.UsbEndpoint","android.hardware.usb.UsbDeviceConnection","android.hardware.usb.UsbManager","android.bluetooth.BluetoothDevice","android.bluetooth.BluetoothAdapter","android.bluetooth.BluetoothManager","android.app.PendingIntent"}){
            Class<?> type=Class.forName(name,false,OptionalHardware.class.getClassLoader());
            for(var constructor:type.getDeclaredConstructors())constructor.getParameterTypes();
            for(var method:type.getDeclaredMethods()){method.getReturnType();method.getParameterTypes();}
        }
        if(!Context.USB_SERVICE.equals(context.getSystemServiceName(UsbManager.class))||!Context.BLUETOOTH_SERVICE.equals(context.getSystemServiceName(BluetoothManager.class)))throw new AssertionError("Original service metadata");
        if(android.os.ServiceManager.checkService(Context.USB_SERVICE)!=null||android.os.ServiceManager.checkService(Context.BLUETOOTH_SERVICE)!=null)throw new AssertionError("Unavailable device endpoint fabricated");
        if(android.bluetooth.BluetoothAdapter.getDefaultAdapter()!=null)throw new AssertionError("Unavailable Bluetooth adapter fabricated");
    }
}
