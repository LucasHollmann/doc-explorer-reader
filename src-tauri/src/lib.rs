use serde::Serialize;
use std::fs;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![read_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
