use super::*;

pub(crate) fn render_updated_core_yaml(
    document: &mut yaml_serde_edit::YamlValue,
    updated: serde_norway::Value,
) -> Result<String, String> {
    document.set(updated);
    let rendered = expand_top_level_flow_style_collections(&document.get_string(), document.get())?;
    let rendered = indent_indentationless_yaml_sequences(&rendered);
    let validated = serde_norway::from_str::<serde_norway::Value>(&rendered)
        .map_err(|error| format!("Failed to validate updated kernel configuration: {error}"))?;
    if &validated != document.get() {
        let path = first_yaml_mismatch_path(document.get(), &validated, &mut Vec::new())
            .unwrap_or_else(|| "<unknown>".to_string());
        return Err(format!(
            "Updated kernel configuration does not match the expected value (path: {path}); write rejected"
        ));
    }
    Ok(rendered)
}

pub(crate) fn expand_top_level_flow_style_collections(
    content: &str,
    document: &serde_norway::Value,
) -> Result<String, String> {
    let root = document
        .as_mapping()
        .ok_or_else(|| "Kernel configuration root must be a YAML mapping".to_string())?;
    let mut rendered = content.to_string();
    for (key, value) in root {
        let Some(key) = key.as_str() else {
            continue;
        };
        let is_non_empty_collection = match value {
            serde_norway::Value::Mapping(mapping) => !mapping.is_empty(),
            serde_norway::Value::Sequence(sequence) => !sequence.is_empty(),
            _ => false,
        };
        if !is_non_empty_collection || !top_level_yaml_entry_uses_flow_style(&rendered, key) {
            continue;
        }
        let mut wrapper = serde_norway::Mapping::new();
        wrapper.insert(yaml_key(key), value.clone());
        let block = serde_norway::to_string(&serde_norway::Value::Mapping(wrapper))
            .map_err(|error| format!("Failed to format kernel YAML configuration: {error}"))?;
        rendered = replace_top_level_yaml_block(&rendered, key, &block);
    }
    Ok(rendered)
}

pub(crate) fn top_level_yaml_entry_uses_flow_style(content: &str, key: &str) -> bool {
    let prefix = format!("{key}:");
    yaml_line_ranges(content).into_iter().any(|range| {
        let line = yaml_line_content(content, range);
        if line.chars().next().is_some_and(char::is_whitespace) {
            return false;
        }
        line.strip_prefix(&prefix)
            .map(str::trim_start)
            .is_some_and(|value| value.starts_with('[') || value.starts_with('{'))
    })
}

pub(crate) fn indent_indentationless_yaml_sequences(content: &str) -> String {
    let mut lines = content
        .split_inclusive('\n')
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !content.is_empty() && !content.ends_with('\n') && lines.is_empty() {
        lines.push(content.to_string());
    }

    loop {
        let mut range_to_indent = None;
        for key_index in 0..lines.len() {
            let key_line = lines[key_index].trim_end_matches(['\r', '\n']);
            let key_trimmed = key_line.trim_start_matches(' ');
            if key_trimmed.is_empty()
                || key_trimmed.starts_with('#')
                || key_trimmed.starts_with('-')
                || !key_trimmed.ends_with(':')
            {
                continue;
            }
            let parent_indent = key_line.len() - key_trimmed.len();
            let Some(first_item) = ((key_index + 1)..lines.len()).find(|index| {
                let line = lines[*index].trim_end_matches(['\r', '\n']).trim();
                !line.is_empty() && !line.starts_with('#')
            }) else {
                continue;
            };
            let first_line = lines[first_item].trim_end_matches(['\r', '\n']);
            let first_trimmed = first_line.trim_start_matches(' ');
            let first_indent = first_line.len() - first_trimmed.len();
            if first_indent != parent_indent
                || !is_indentationless_yaml_sequence_item(first_trimmed)
            {
                continue;
            }

            let mut end = first_item;
            while end < lines.len() {
                let line = lines[end].trim_end_matches(['\r', '\n']);
                let trimmed = line.trim_start_matches(' ');
                if !trimmed.is_empty() {
                    let indent = line.len() - trimmed.len();
                    if indent < parent_indent
                        || (indent == parent_indent
                            && !is_indentationless_yaml_sequence_item(trimmed))
                    {
                        break;
                    }
                }
                end += 1;
            }
            range_to_indent = Some((first_item, end));
            break;
        }

        let Some((start, end)) = range_to_indent else {
            break;
        };
        for line in &mut lines[start..end] {
            if !line.trim().is_empty() {
                line.insert_str(0, "  ");
            }
        }
    }
    lines.concat()
}

pub(crate) fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = value.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }
    let shortened: String = trimmed.chars().take(LIMIT).collect();
    format!("{shortened}…")
}

pub(crate) fn open_external_url_inner(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Link is empty".to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http/https links can be opened".to_string());
    }

    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| format!("Failed to open browser: {err}"))
}
