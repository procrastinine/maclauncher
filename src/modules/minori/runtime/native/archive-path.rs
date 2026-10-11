// SPDX-License-Identifier: AGPL-3.0-or-later
// Resolve original Windows archive casing in place; never rename or copy data.
use super::PazError;
use std::path::{Path, PathBuf};
pub fn archive_path(root: &Path, group: &str) -> Result<PathBuf, PazError> {
    if !crate::paz_keys::ARCHIVE_ORDER.contains(&group) { return Err(PazError::BadIndex); }
    let wanted = format!("{group}.paz"); let mut found = None; let mut count = 0;
    for entry in std::fs::read_dir(root)? {
        count += 1;
        if count > 4096 { return Err(PazError::Io(std::io::Error::other("PAZ directory exceeds its file limit"))); }
        let entry = entry?;
        if !entry.file_name().to_string_lossy().eq_ignore_ascii_case(&wanted) { continue; }
        if !entry.file_type()?.is_file() || found.is_some() {
            return Err(PazError::Io(std::io::Error::other("PAZ archive path is linked or ambiguous")));
        }
        found = Some(entry.path());
    }
    found.ok_or_else(|| PazError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, format!("Missing {wanted}"))))
}
