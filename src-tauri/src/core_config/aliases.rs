//! Model alias configuration, source resolution and rendering.
//!
//! - `channels`: OAuth channel definitions and discovery
//! - `management`: management API compatibility
//! - `claude_desktop`: Claude Desktop role aliases
//! - `sources`: thinking and speed source resolution
//! - `entries`: configured alias entries and payload parameters
//! - `mutation`: alias mutation and payload cleanup
//! - `render`: YAML rendering helpers

use super::*;
use std::collections::BTreeSet;

pub(crate) fn existing_thinking_alias_model_id(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if value.len() > 240 || value.chars().any(char::is_control) {
        return Err(format!("Invalid {label} format"));
    }
    Ok(value.to_string())
}

pub(crate) fn validate_thinking_alias_model_id(value: &str, label: &str) -> Result<String, String> {
    let value = existing_thinking_alias_model_id(value, label)?;
    if value
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(format!("Invalid {label} format; whitespace is not allowed"));
    }
    Ok(value)
}

pub(crate) fn validate_thinking_alias_effort(value: &str) -> Result<String, String> {
    let effort = value.trim().to_ascii_lowercase();
    if effort.is_empty() {
        return Err("Reasoning effort cannot be empty".to_string());
    }
    if effort.chars().all(|character| character.is_ascii_digit()) {
        return Err("Fixed reasoning aliases do not support numeric-only budgets. Enter a reasoning level name".to_string());
    }
    if effort.len() > 64
        || !effort.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("Invalid reasoning effort format. Only letters, numbers, hyphens, underscores, and periods are allowed".to_string());
    }
    Ok(effort)
}

fn claude_desktop_has_other_model_family(name: &str) -> bool {
    static OTHER_MODEL_FAMILY: LazyLock<regex::Regex> = LazyLock::new(|| {
        let rules: serde_json::Value = serde_json::from_str(include_str!(
            "../../../src/services/claudeDesktopModelRules.json"
        ))
        .expect("valid bundled Claude Desktop model rules");
        regex::RegexBuilder::new(
            rules["otherModelFamilyPattern"]
                .as_str()
                .expect("Claude Desktop model-family pattern"),
        )
        .unicode(false)
        .build()
        .expect("valid Claude Desktop model-family pattern")
    });
    OTHER_MODEL_FAMILY.is_match(&name.to_ascii_lowercase())
}

mod channels;
mod management;
mod claude_desktop;
mod sources;
mod entries;
mod mutation;
mod render;

pub(crate) use channels::*;
pub(crate) use management::*;
pub(crate) use claude_desktop::*;
pub(crate) use sources::*;
pub(crate) use entries::*;
pub(crate) use mutation::*;
pub(crate) use render::*;
