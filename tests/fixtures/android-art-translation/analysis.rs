use crate::xlate;
use std::{hint::black_box, time::Duration};

fn thread_cpu() -> Duration {
    let mut value: libc::timespec = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut value) }, 0);
    Duration::new(value.tv_sec as u64, value.tv_nsec as u32)
}

#[test]
fn original_analysis_is_reused_without_changing_output() {
    let files: Vec<_> = std::env::split_paths(&std::env::var_os("ANDROID_TRANSLATION_PROBE_ELFS").expect("original runtime ELF inputs")).collect();
    assert!(!files.is_empty());
    for file in files {
        let bytes = std::fs::read(&file).unwrap();
        let elf = xlate::elf::parse(&bytes).unwrap();
        let options = xlate::Options::default();
        let analysis = xlate::analyze(&elf);
        let original = xlate::translate(&bytes, &options).unwrap();
        let reused = xlate::translate_analyzed(&elf, &analysis, &options).unwrap();
        assert_eq!(original.outcome, reused.outcome);
        assert_eq!(format!("{:?}", original.report), format!("{:?}", reused.report));
        let mut previous = Duration::ZERO;
        let mut corrected = Duration::ZERO;
        for iteration in 0..6 {
            for optimized in [iteration % 2 == 0, iteration % 2 != 0] {
                let started = thread_cpu();
                let parsed = xlate::elf::parse(&bytes).unwrap();
                let current = xlate::analyze(&parsed);
                let output = if optimized {
                    xlate::translate_analyzed(&parsed, &current, &options).unwrap()
                } else {
                    xlate::translate(&bytes, &options).unwrap()
                };
                black_box(output);
                black_box(current);
                if optimized { corrected += thread_cpu() - started; }
                else { previous += thread_cpu() - started; }
            }
        }
        println!("Original ELF {}: previous_two_analyses_cpu_ms={:.3} reused_analysis_cpu_ms={:.3} iterations=6 outcome={}",
            file.display(), previous.as_secs_f64() * 1000.0, corrected.as_secs_f64() * 1000.0, reused.outcome.name());
    }
}
