use super::*;

pub(crate) fn deserialize_release_notes<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    // Untagged legacy text and invalid entries cannot identify a translation.
    // Treat them as unavailable instead of failing the entire version check.
    let mut notes = HashMap::new();
    if let Some(translations) = value.as_object() {
        for locale in ["zh-CN", "zh-TW", "en", "ja"] {
            if let Some(text) = translations.get(locale).and_then(|value| value.as_str()) {
                if !text.trim().is_empty() {
                    notes.insert(locale.to_string(), text.to_string());
                }
            }
        }
    }
    Ok(notes)
}

#[tauri::command]
pub(crate) fn get_version_source_settings(
    gui_config_state: tauri::State<'_, GuiConfigState>,
) -> Result<VersionSourceSettings, String> {
    let config = gui_config_state.snapshot()?;
    Ok(version_source_settings(&config))
}

fn version_source_settings(config: &GuiConfigFile) -> VersionSourceSettings {
    VersionSourceSettings {
        source: config.selected_download_candidate().key(),
        gitcode_available: gitcode_version_source_available(),
        custom_mirrors: config.custom_download_mirrors.clone(),
    }
}

#[tauri::command]
pub(crate) fn set_download_source(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    source: String,
) -> Result<VersionSourceSettings, String> {
    let candidate = if let Some(url) = source.strip_prefix("custom:") {
        VersionDownloadCandidate::custom(&normalize_custom_download_mirror_url(url)?)
    } else {
        VersionDownloadCandidate::builtin(
            VersionDownloadSource::from_str(&source)
                .filter(|source| *source != VersionDownloadSource::Custom)
                .ok_or_else(|| "Unsupported download source".to_string())?,
        )
    };
    if candidate.source == VersionDownloadSource::Gitcode && !gitcode_version_source_available() {
        return Err("This build does not include complete GitCode application and kernel mirror sources".to_string());
    }
    let config = gui_config_state.set_download_candidate(candidate)?;
    Ok(version_source_settings(&config))
}

#[tauri::command]
pub(crate) fn add_custom_download_mirror(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    url: String,
) -> Result<VersionSourceSettings, String> {
    let url = normalize_custom_download_mirror_url(&url)?;
    let config = gui_config_state.update(|config| {
        if !config.custom_download_mirrors.contains(&url) {
            if config.custom_download_mirrors.len() >= 12 {
                return Err("You can add up to 12 custom mirrors".to_string());
            }
            config.custom_download_mirrors.push(url.clone());
        }
        config.download_source = VersionDownloadSource::Custom;
        config.active_custom_download_mirror = url.clone();
        config.prefer_gitcode_downloads = false;
        Ok(())
    })?;
    Ok(version_source_settings(&config))
}

#[tauri::command]
pub(crate) fn remove_custom_download_mirror(
    gui_config_state: tauri::State<'_, GuiConfigState>,
    url: String,
) -> Result<VersionSourceSettings, String> {
    let url = normalize_custom_download_mirror_url(&url)?;
    let config = gui_config_state.update(|config| {
        config.custom_download_mirrors.retain(|item| item != &url);
        if config.download_source == VersionDownloadSource::Custom
            && config.active_custom_download_mirror == url
        {
            config.download_source = VersionDownloadSource::Github;
            config.active_custom_download_mirror.clear();
        }
        Ok(())
    })?;
    Ok(version_source_settings(&config))
}

pub(crate) fn gitcode_version_source_available() -> bool {
    configured_gitcode_gui_repository().is_some() && configured_gitcode_core_repository().is_some()
}

pub(crate) fn persist_automatic_download_source_switch(
    app: &tauri::AppHandle,
    gui_config_state: &GuiConfigState,
    requested_source: &VersionDownloadCandidate,
    resolved_source: &VersionDownloadCandidate,
) -> Result<(), String> {
    let Some(config) =
        gui_config_state.switch_download_source_after_failure(requested_source, resolved_source)?
    else {
        return Ok(());
    };
    app.emit(
        VERSION_DOWNLOAD_SOURCE_CHANGED_EVENT,
        version_source_settings(&config),
    )
    .map_err(|error| format!("Failed to notify automatic download source switch: {error}"))
}

#[tauri::command]
pub(crate) fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    open_external_url_inner(&app, &url)
}

#[tauri::command]
