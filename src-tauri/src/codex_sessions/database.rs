use super::*;

pub(super) fn resolve_codex_home(user_home: &Path) -> PathBuf {
    existing_env_directory("CODEX_HOME").unwrap_or_else(|| user_home.join(".codex"))
}

pub(super) fn resolve_sqlite_home(codex_home: &Path) -> PathBuf {
    existing_env_directory("CODEX_SQLITE_HOME").unwrap_or_else(|| codex_home.to_path_buf())
}

fn existing_env_directory(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os(name).map(PathBuf::from)?;
    (!path.as_os_str().is_empty() && path.is_dir()).then_some(path)
}

pub(super) fn open_read_only(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open database {}: {error}", path.display()))?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|error| format!("Failed to set database timeout {}: {error}", path.display()))?;
    Ok(connection)
}

pub(super) fn open_read_write(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Failed to open database {}: {error}", path.display()))?;
    connection
        .busy_timeout(SQLITE_BUSY_TIMEOUT)
        .map_err(|error| format!("Failed to set database timeout {}: {error}", path.display()))?;
    Ok(connection)
}

fn sqlite_candidate(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            ["db", "sqlite", "sqlite3"]
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

pub(super) fn discover_database_paths(codex_home: &Path, reference_only: bool) -> (Vec<PathBuf>, Vec<String>) {
    let sqlite_home = resolve_sqlite_home(codex_home);
    let mut candidates = Vec::new();
    let mut warnings = Vec::new();
    let sqlite_dir = sqlite_home.join("sqlite");
    if let Ok(entries) = fs::read_dir(&sqlite_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && sqlite_candidate(&path) {
                candidates.push(path);
            }
        }
    }
    let legacy = sqlite_home.join("state_5.sqlite");
    if legacy.is_file() && !candidates.contains(&legacy) {
        candidates.push(legacy.clone());
    }
    candidates.sort_by_key(|path| {
        let legacy_rank = usize::from(path == &legacy);
        let codex_dev_rank =
            usize::from(path.file_name().and_then(OsStr::to_str) != Some("codex-dev.db"));
        (
            legacy_rank,
            codex_dev_rank,
            path.file_name().map(OsStr::to_os_string),
        )
    });
    let wanted = if reference_only {
        REFERENCE_TABLE_COLUMNS
            .iter()
            .map(|(table, _)| *table)
            .collect::<HashSet<_>>()
    } else {
        ["threads", "automation_runs", "inbox_items"]
            .into_iter()
            .collect::<HashSet<_>>()
    };
    let mut discovered = Vec::new();
    for path in candidates {
        let connection = match open_read_only(&path) {
            Ok(connection) => connection,
            Err(error) => {
                warnings.push(error);
                continue;
            }
        };
        let mut has_supported_table = false;
        for table in &wanted {
            match table_exists(&connection, table) {
                Ok(true) => has_supported_table = true,
                Ok(false) => {}
                Err(error) => {
                    warnings.push(format!("Failed to inspect database schema {}: {error}", path.display()))
                }
            }
        }
        if has_supported_table {
            discovered.push(path);
        }
    }
    (discovered, warnings)
}

pub(super) fn table_exists(connection: &Connection, table: &str) -> Result<bool, String> {
    match connection.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
        [table],
        |_| Ok(()),
    ) {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(error) => Err(format!("Failed to read SQLite table list: {error}")),
    }
}

pub(super) fn table_columns(connection: &Connection, table: &str) -> Result<HashSet<String>, String> {
    if !table_exists(connection, table)? {
        return Ok(HashSet::new());
    }
    let mut statement = connection
        .prepare(&format!(
            "PRAGMA table_info(\"{}\")",
            table.replace('"', "\"\"")
        ))
        .map_err(|error| format!("Failed to read {table} table schema: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Failed to read {table} table schema: {error}"))?;
    rows.collect::<rusqlite::Result<HashSet<_>>>()
        .map_err(|error| format!("Failed to read {table} table schema: {error}"))
}

pub(super) fn optional_column<'a>(columns: &HashSet<String>, column: &'a str, fallback: &'a str) -> &'a str {
    if columns.contains(column) {
        column
    } else {
        fallback
    }
}

pub(super) fn normalized_millis_expression(column: &str) -> String {
    format!(
        "CASE WHEN {column} IS NULL THEN NULL WHEN ABS({column}) < 100000000000 THEN CAST({column} * 1000 AS INTEGER) ELSE CAST({column} AS INTEGER) END"
    )
}
