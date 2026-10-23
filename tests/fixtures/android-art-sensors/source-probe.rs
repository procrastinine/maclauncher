#[path="../../../src/modules/android/art/sensors/source.rs"]mod source;
use android_hardware_sensors::aidl::android::hardware::sensors::SensorType::SensorType;
fn main(){
 let root=std::env::args().nth(1).unwrap();
 for(name,tilted)in[("neutral",false),("tilted",true)]{
  let source=source::Source::open(&std::path::Path::new(&root).join(name)).unwrap();let sensors=source.list();assert_eq!(sensors.len(),7);
  let(time,rows)=source.snapshot().expect("Published coherent epoch");assert!(time>0);
  let index=sensors.iter().position(|s|s.r#type==SensorType::GRAVITY).unwrap();
  if tilted{assert!(rows[index][0]>4.,"Q motion must come from shared source: {:?}",rows[index]);}else{assert!(rows[index][0].abs()<0.01);assert!((rows[index][2]-9.80665).abs()<0.01);}
  let payload=source.payload(index,rows[index]);println!("{name} original descriptor {:?}; payload {:?}",sensors[index],payload);
 }
 let off=source::Source::open(&std::path::Path::new(&root).join("off")).unwrap();assert!(off.list().is_empty());assert!(off.snapshot().unwrap().1.is_empty());
 println!("PASS original AIDL sensor descriptors and shared Java motion snapshots");
}
