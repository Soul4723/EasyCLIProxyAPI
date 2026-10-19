use super::*;

#[tauri::command]
pub(crate) async fn save_usage_events_export(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_usage_events_export(&path, &contents))
        .await
        .map_err(|error| format!("Failed to save usage export: {error}"))?
}

pub(super) fn write_usage_events_export(path: &str, contents: &str) -> Result<(), String> {
    let path = validated_usage_export_path(path)?;
    fs::write(&path, contents.as_bytes())
        .map_err(|error| format!("Failed to write usage export {}: {error}", path.display()))
}

pub(super) fn validated_usage_export_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err("Usage export path is invalid".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Usage export path must be an absolute file path".to_string());
    }
    if path.file_name().is_none_or(|name| name.is_empty()) {
        return Err("Usage export path must include a file name".to_string());
    }
    if path.is_dir() {
        return Err("Usage export path is a directory".to_string());
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "Usage export path has no directory".to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "Usage export directory does not exist: {}",
            parent.display()
        ));
    }
    Ok(path)
}

#[cfg(test)]
mod save_usage_events_export_tests {
    use super::{validated_usage_export_path, write_usage_events_export};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "cpa-usage-export-{}-{}-{}",
                std::process::id(),
                label,
                stamp
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_the_selected_csv_and_replaces_an_existing_file() {
        let directory = TempDir::new("write");
        let path = directory.path().join("usage.csv");
        fs::write(&path, "old").unwrap();
        let selected = path.to_string_lossy().into_owned();
        write_usage_events_export(&selected, "\u{feff}id\r\n1").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "\u{feff}id\r\n1");
    }

    #[test]
    fn rejects_relative_paths_missing_directories_and_directories() {
        let directory = TempDir::new("reject");
        assert!(validated_usage_export_path("usage.csv").is_err());
        assert!(validated_usage_export_path(&directory.path().to_string_lossy()).is_err());
        let missing = directory
            .path()
            .join("missing")
            .join("usage.csv")
            .to_string_lossy()
            .into_owned();
        assert!(write_usage_events_export(&missing, "id").is_err());
    }
}
