use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
struct DirEntryInfo {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    created: Option<u64>,
    modified: Option<u64>,
}

#[derive(Serialize)]
struct DirectorySummary {
    item_count: u64,
    size_bytes: u64,
}

fn to_epoch_secs(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

#[tauri::command]
fn read_directory(path: String) -> Result<Vec<DirEntryInfo>, String> {
    let entries = fs::read_dir(&path).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let created = to_epoch_secs(metadata.created());
        let modified = to_epoch_secs(metadata.modified());

        result.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            created,
            modified,
        });
    }

    result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(result)
}

#[tauri::command]
async fn directory_summary(path: String) -> Result<DirectorySummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(path);
        let mut pending = vec![root.clone()];
        let mut item_count = 0_u64;
        let mut size_bytes = 0_u64;

        while let Some(directory) = pending.pop() {
            let entries = fs::read_dir(&directory).map_err(|error| error.to_string())?;
            for entry in entries {
                let entry = entry.map_err(|error| error.to_string())?;
                if directory == root {
                    item_count = item_count.checked_add(1).ok_or_else(|| {
                        "Folder item count exceeds the supported range.".to_string()
                    })?;
                }

                let file_type = entry.file_type().map_err(|error| error.to_string())?;
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    pending.push(entry.path());
                    continue;
                }

                let size = entry.metadata().map_err(|error| error.to_string())?.len();
                size_bytes = size_bytes
                    .checked_add(size)
                    .ok_or_else(|| "Folder size exceeds the supported range.".to_string())?;
            }
        }

        Ok(DirectorySummary {
            item_count,
            size_bytes,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![read_directory, directory_summary])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
