use super::*;

const NAME:&str="vfs::maclauncher_fuse_bind::recursive_copy_retains_late_child_mount_identity";

#[test]
fn recursive_copy_retains_late_child_mount_identity(){
    if crate::sys::fdtab::isolated_kernel_test(NAME){return;}
    let (_guard,root)=test_view();
    let base=root.join("late-bind-source");
    let lower=root.join("late-bind-lower");
    let other=root.join("late-bind-other");
    for p in [&base,&lower,&other]{std::fs::create_dir_all(p).unwrap();}
    std::fs::create_dir_all(lower.join("pkg/files")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&lower,std::fs::Permissions::from_mode(0o750)).unwrap();
    std::fs::write(lower.join("pkg/files/original"),b"original lower bytes").unwrap();
    set_mount_propagation("/",(1<<20)|0x4000).unwrap();
    add_mount("/mnt/late-user",base.clone(),Area::Writable,"user","tmpfs").unwrap();
    add_mount("/data/late-lower",lower.clone(),Area::Writable,"lower","tmpfs").unwrap();
    let parent=own_mounts_text();
    // Zygote's slave namespace exists before vold installs the FUSE mount.
    private_mount_namespace().unwrap();set_mount_propagation("/",(1<<19)|0x4000).unwrap();
    let early_slave=own_mounts_text();
    load_own_mounts(&parent).unwrap();
    install_mount("/mnt/late-user/emulated",base.clone(),Area::Writable,"/dev/fuse","fuse",Some(FuseRoute{session:root.join("registered-session/c.sock"),relative:String::new(),uid:0,gid:0,allow_other:true,default_permissions:false,read_only:false}),None).unwrap();
    let fuse_parent=own_mounts_text();
    load_own_mounts(&early_slave).unwrap();refresh_fuse_mounts().unwrap();
    assert!(fuse_route("/mnt/late-user/emulated/0").is_some());
    // App specialization recursively copies the currently imported mount.
    private_mount_namespace().unwrap();set_mount_propagation("/",(1<<19)|0x4000).unwrap();
    bind_mount_recursive("/mnt/late-user","/storage/late-slave",base.clone(),Area::Writable,true).unwrap();
    bind_mount_recursive("/mnt/late-user","/storage/late-private",base.clone(),Area::Writable,true).unwrap();
    set_mount_propagation("/storage/late-private",(1<<18)|0x4000).unwrap();
    let copied=NAMESPACE_VIEW.lock().unwrap().as_ref().unwrap().owner.read().unwrap();
    let cloned=copied.mounts.iter().rev().find(|m|m.guest=="/storage/late-slave/emulated").unwrap();
    assert_ne!(cloned.master,0,"recursive imported FUSE child lost its slave master identity");
    assert_eq!(cloned.root,"/");
    let copied_master=cloned.master;
    let app=own_mounts_text();
    // Original late mount publication remains in the parent namespace.
    load_own_mounts(&fuse_parent).unwrap();
    bind_mount("/data/late-lower","/mnt/late-user/emulated/0/Android/data",lower.clone(),Area::Writable,"/data/late-lower","bind").unwrap();
    add_mount("/mnt/unrelated",other.clone(),Area::Writable,"unrelated","tmpfs").unwrap();
    load_own_mounts(&app).unwrap();refresh_fuse_mounts().unwrap();
    let path="/storage/late-slave/emulated/0/Android/data/pkg/files/original";
    assert_eq!(lookup(path).0,lower.join("pkg/files/original"),"late lower child did not reach copied slave");
    assert!(fuse_route(path).is_none());
    assert_eq!(std::fs::read(lookup(path).0).unwrap(),b"original lower bytes");
    assert_eq!(std::fs::metadata(&lower).unwrap().permissions().mode()&0o777,0o750);
    assert_ne!(lookup("/storage/late-private/emulated/0/Android/data/pkg/files/original").0,lower.join("pkg/files/original"));
    assert!(fuse_route("/storage/late-private/emulated/0/Android/data/pkg").is_some());
    assert_ne!(lookup("/storage/late-slave/unrelated").0,other);
    let points=mount_points().unwrap();
    let copied=points.iter().rev().find(|m|m.guest=="/storage/late-slave/emulated").unwrap();
    assert_eq!(copied.master,copied_master);assert_eq!(copied.root,"/");
    let inherited=own_mounts_text();load_own_mounts(&inherited).unwrap();refresh_fuse_mounts().unwrap();
    assert_eq!(lookup(path).0,lower.join("pkg/files/original"));
    println!("FUSE_BIND_PASS: late child follows copied master/root across original namespace replay; private and unrelated views excluded; bytes/mode unchanged");
}

#[test]
fn self_recursive_copy_retains_the_previous_child_mount_object(){
    const SELF:&str="vfs::maclauncher_fuse_bind::self_recursive_copy_retains_the_previous_child_mount_object";
    if crate::sys::fdtab::isolated_kernel_test(SELF){return;}
    let (_guard,root)=test_view();
    let lower=root.join("self-lower");let tree=root.join("self-tree");
    std::fs::create_dir_all(lower.join("subtree")).unwrap();std::fs::create_dir_all(&tree).unwrap();
    std::fs::write(lower.join("subtree/original"),b"same original object").unwrap();
    set_mount_propagation("/",(1<<20)|0x4000).unwrap();
    add_mount("/lower",lower.clone(),Area::Writable,"original-lower","tmpfs").unwrap();
    set_mount_propagation("/lower",1<<19).unwrap();set_mount_propagation("/lower",1<<20).unwrap();
    add_mount("/tree",tree.clone(),Area::Writable,"original-tree","tmpfs").unwrap();
    bind_mount_recursive("/lower/subtree","/tree/child",lower.join("subtree"),Area::Writable,false).unwrap();
    let owner=NAMESPACE_VIEW.lock().unwrap().as_ref().unwrap().owner.clone();
    let prior=owner.read().unwrap();
    let before=prior.mounts.iter().rev().find(|m|m.guest=="/tree/child").unwrap().clone();
    let parent=prior.mounts.iter().rev().find(|m|m.guest=="/tree").unwrap().clone();
    assert_eq!(before.root,"/subtree");assert_ne!(before.shared,0);assert_ne!(before.master,0);
    assert_ne!(before.shared,parent.shared);
    bind_mount_recursive("/tree","/tree",tree,Area::Writable,true).unwrap();
    let after=owner.read().unwrap();
    let copied=after.mounts.iter().rev().find(|m|m.guest=="/tree/child").unwrap();
    assert_ne!(copied.id,before.id);
    assert_eq!((&copied.root,copied.shared,copied.master),(&before.root,before.shared,before.master),"self bind changed the prior child object root/peer/master");
    let copied_parent=after.mounts.iter().rev().find(|m|m.guest=="/tree").unwrap();
    assert_eq!((&copied_parent.root,copied_parent.shared,copied_parent.master),(&parent.root,parent.shared,parent.master));
    assert_eq!(lookup("/tree/child/original").0,lower.join("subtree/original"));
    assert_eq!(std::fs::read(lookup("/tree/child/original").0).unwrap(),b"same original object");
}
