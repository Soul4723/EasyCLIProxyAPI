//! Pure quoting for Windows launchers.
//!
//! Nothing here touches the OS, so it is unit-tested on every platform. The Windows-only
//! call sites hand the strings built here to `raw_arg` or `ProcessStartInfo.Arguments`.
//!
//! `cmd.exe` does not understand MSVC `\"` escaping, so arguments given to a `.cmd`/`.bat`
//! file through `Command::args` after an explicit `cmd.exe /C` can end a quoted string early
//! and run the rest as commands. The rules below are the ones Rust's standard library uses
//! for batch files (the CVE-2024-24576 fix): quote, double `"`, and neutralise `%`.

use std::path::Path;

/// PowerShell treats all of these as the single quote that delimits a literal string.
const POWERSHELL_SINGLE_QUOTES: [char; 5] = ['\'', '\u{2018}', '\u{2019}', '\u{201A}', '\u{201B}'];

/// ASCII punctuation that `cmd.exe` leaves alone outside quotes. Everything else is quoted.
const CMD_UNQUOTED_PUNCTUATION: &str = r"#$*+-./:?@\_";

/// Characters that stay active in a command line that Windows Terminal re-quotes for us,
/// so they cannot be passed to a batch file through it at all.
const WINDOWS_TERMINAL_BATCH_UNSAFE: &str = "\"&|<>^%()!;";

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_powershell_single_quoted_literal(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for character in value.chars() {
        quoted.push(character);
        if POWERSHELL_SINGLE_QUOTES.contains(&character) {
            quoted.push(character);
        }
    }
    quoted.push('\'');
    quoted
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn is_windows_batch_script(executable: &Path) -> bool {
    executable
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
}

/// Quotes one argument for a `cmd.exe` command line that runs a batch file.
///
/// Inside the quotes `& | < > ^ ( )` are literal, `"` is doubled so the quote parity of the
/// line is kept, and `%` becomes `%%cd:~,%`, which `cmd.exe` expands to a single `%`. Line
/// breaks cannot be expressed on a `cmd.exe` command line and are rejected.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_cmd_batch_argument(argument: &str) -> Result<String, String> {
    if argument.chars().any(|character| matches!(character, '\0' | '\r' | '\n')) {
        return Err(
            "Windows batch launchers cannot receive text with line breaks. Remove the line breaks or use a native (.exe) install"
                .to_string(),
        );
    }
    // An empty argument and a trailing backslash both need quotes to survive.
    let quote = argument.is_empty()
        || argument.ends_with('\\')
        || argument.chars().any(|character| {
            (character.is_ascii()
                && !(character.is_ascii_alphanumeric()
                    || CMD_UNQUOTED_PUNCTUATION.contains(character)))
                || character.is_control()
        });
    let mut quoted = String::with_capacity(argument.len() + 2);
    if quote {
        quoted.push('"');
    }
    let mut backslashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else {
            if character == '"' {
                // Keep the batch file's own MSVC parse of the argument intact.
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push('"');
            } else if character == '%' {
                quoted.push_str("%%cd:~,");
            }
            backslashes = 0;
        }
        quoted.push(character);
    }
    if quote {
        quoted.push_str(&"\\".repeat(backslashes));
        quoted.push('"');
    }
    Ok(quoted)
}

/// Everything after `cmd.exe` for running `program` (a batch file or native program) with
/// `arguments`, optionally after `cd /d <working_directory>`.
///
/// `/S` makes `cmd.exe` strip exactly the outer pair of quotes, `/V:OFF` keeps `!` literal
/// even when delayed expansion is enabled in the registry, and there is deliberately no
/// `call`: `call` expands `%` and `^` a second time.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_cmd_command_line<S: AsRef<str>>(
    working_directory: Option<&str>,
    program: &str,
    arguments: &[S],
    keep_shell_open: bool,
) -> Result<String, String> {
    let mut line = String::new();
    if let Some(directory) = working_directory {
        line.push_str("cd /d ");
        line.push_str(&windows_cmd_batch_argument(directory)?);
        line.push_str(" && ");
    }
    line.push_str(&windows_cmd_batch_argument(program)?);
    for argument in arguments {
        line.push(' ');
        line.push_str(&windows_cmd_batch_argument(argument.as_ref())?);
    }
    Ok(format!(
        "/D /E:ON /V:OFF /S /{} \"{line}\"",
        if keep_shell_open { 'K' } else { 'C' }
    ))
}

fn windows_terminal_batch_unsafe_character(text: &str) -> Option<char> {
    text.chars()
        .find(|character| WINDOWS_TERMINAL_BATCH_UNSAFE.contains(*character) || character.is_control())
}

/// Windows Terminal splits the text after `--` itself and re-quotes it with MSVC rules,
/// which `cmd.exe` does not honour, so a batch file can only receive arguments that need
/// no `cmd.exe` quoting at all.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn validate_windows_terminal_batch_arguments<S: AsRef<str>>(
    arguments: &[S],
) -> Result<(), String> {
    for argument in arguments {
        if let Some(character) = windows_terminal_batch_unsafe_character(argument.as_ref()) {
            return Err(format!(
                "Windows Terminal cannot safely pass {character:?} to a .cmd launcher. Use the PowerShell or Command Prompt terminal, or remove the character"
            ));
        }
    }
    Ok(())
}

/// The same rule for the launcher path itself: it is on the same re-quoted command line,
/// and `cmd.exe` would expand `%VAR%` in it (twice, because of `call`).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn validate_windows_terminal_batch_path(executable: &str) -> Result<(), String> {
    match windows_terminal_batch_unsafe_character(executable) {
        Some(character) => Err(format!(
            "Windows Terminal cannot safely start the .cmd launcher {executable} because its path contains {character:?}. Use the PowerShell or Command Prompt terminal, or move the launcher"
        )),
        None => Ok(()),
    }
}

/// Whether a batch file path holds anything `cmd.exe` would act on. PowerShell then starts
/// it through an explicit `cmd.exe` line instead of running the path directly.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn windows_batch_path_has_cmd_metacharacters(executable: &str) -> bool {
    windows_terminal_batch_unsafe_character(executable).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small model of how `cmd.exe` reads a command line. It returns every place where the
    /// line would stop being plain data: an unquoted metacharacter or a `%` that is not the
    /// `%%cd:~,%` placeholder. `""` inside quotes is two toggles, as in `cmd.exe`.
    fn active_metacharacters(line: &str) -> Vec<String> {
        let mut findings = Vec::new();
        let characters = line.chars().collect::<Vec<_>>();
        let mut quoted = false;
        let mut index = 0;
        while index < characters.len() {
            let character = characters[index];
            if character == '"' {
                quoted = !quoted;
            } else if character == '%' {
                let rest = characters[index..].iter().collect::<String>();
                if rest.starts_with("%%cd:~,%") {
                    index += "%%cd:~,%".len();
                    continue;
                }
                findings.push(format!("bare % at {index}"));
            } else if matches!(character, '\r' | '\n' | '\0') {
                findings.push(format!("line break at {index}"));
            } else if !quoted && matches!(character, '&' | '|' | '<' | '>' | '^' | '(' | ')') {
                findings.push(format!("unquoted {character} at {index}"));
            }
            index += 1;
        }
        if quoted {
            findings.push("unterminated quote".to_string());
        }
        findings
    }

    /// The payload between the outer quotes that `/S` strips.
    fn inner_command(command_line: &str) -> &str {
        let (_, rest) = command_line.split_once(" /S /").unwrap();
        let rest = &rest[2..];
        assert!(rest.starts_with('"') && rest.ends_with('"'), "{command_line}");
        &rest[1..rest.len() - 1]
    }

    const HOSTILE: &[&str] = &[
        "& calc",
        "a&calc",
        "\" & calc & \"",
        "fix \"x\" & powershell -c calc",
        "%PATH%",
        "100%",
        "%%",
        "%COMSPEC% /c calc",
        "^",
        "a^&b",
        "x | calc",
        "x > out.txt",
        "x < in.txt",
        "(calc)",
        "!PATH!",
        "'; calc; '",
        "\u{2018}; calc; \u{2019}",
        "\u{201C}x\u{201D} & calc",
        "trailing backslash\\",
        "C:\\dir\\",
        "quote \\\" then & calc",
        "",
        "plain",
    ];

    #[test]
    fn hostile_arguments_stay_inert_in_a_batch_command_line() {
        for &hostile in HOSTILE {
            let argument = windows_cmd_batch_argument(hostile).unwrap();
            assert_eq!(active_metacharacters(&argument), Vec::<String>::new(), "{hostile:?} -> {argument}");

            let line = windows_cmd_command_line(None, r"C:\Tools\agent shim.cmd", &["--task", hostile], false)
                .unwrap();
            assert!(line.starts_with("/D /E:ON /V:OFF /S /C \""), "{line}");
            assert_eq!(
                active_metacharacters(inner_command(&line)),
                Vec::<String>::new(),
                "{hostile:?} -> {line}"
            );
        }
    }

    #[test]
    fn batch_arguments_have_the_expected_exact_form() {
        for (input, expected) in [
            ("plain", "plain"),
            ("--port=8080", "\"--port=8080\""),
            ("--version", "--version"),
            ("two words", "\"two words\""),
            ("", "\"\""),
            ("& calc", "\"& calc\""),
            ("a&calc", "\"a&calc\""),
            ("\" & calc & \"", "\"\"\" & calc & \"\"\""),
            ("%PATH%", "\"%%cd:~,%PATH%%cd:~,%\""),
            ("^", "\"^\""),
            ("a|b", "\"a|b\""),
            ("line\\", "\"line\\\\\""),
            ("C:\\dir\\", "\"C:\\dir\\\\\""),
            ("say \"hi\"", "\"say \"\"hi\"\"\""),
            ("back\\\"slash", "\"back\\\\\"\"slash\""),
            ("\u{201C}smart\u{201D}", "\u{201C}smart\u{201D}"),
            ("工具 目录", "\"工具 目录\""),
        ] {
            assert_eq!(windows_cmd_batch_argument(input).unwrap(), expected, "{input:?}");
        }
    }

    #[test]
    fn batch_command_line_has_no_call_and_disables_delayed_expansion() {
        let line = windows_cmd_command_line(
            None,
            r"C:\Users\Test User\AppData\Roaming\npm\deepseek.cmd",
            &["web", "--port", "8080"],
            false,
        )
        .unwrap();
        assert_eq!(
            line,
            "/D /E:ON /V:OFF /S /C \"\"C:\\Users\\Test User\\AppData\\Roaming\\npm\\deepseek.cmd\" web --port 8080\""
        );
        assert!(!line.to_ascii_lowercase().contains("call"));

        let interactive = windows_cmd_command_line(
            Some(r"C:\work\a&b"),
            r"C:\tools\agent.bat",
            &["--flag"],
            true,
        )
        .unwrap();
        assert_eq!(
            interactive,
            "/D /E:ON /V:OFF /S /K \"cd /d \"C:\\work\\a&b\" && C:\\tools\\agent.bat --flag\""
        );
        assert_eq!(active_metacharacters(inner_command(&interactive).replace("&&", "").as_str()), Vec::<String>::new());
    }

    #[test]
    fn hostile_script_and_directory_paths_stay_inert() {
        let line = windows_cmd_command_line(
            Some(r"C:\src\a&calc 100%"),
            r"C:\npm&calc\100%\agent.cmd",
            &["x"],
            false,
        )
        .unwrap();
        let inner = inner_command(&line).replace(" && ", " ");
        assert_eq!(active_metacharacters(&inner), Vec::<String>::new(), "{line}");
    }

    #[test]
    fn line_breaks_are_rejected_with_a_clear_error() {
        for hostile in ["a\nb", "a\r\nb", "a\rb", "a\0b"] {
            let error = windows_cmd_batch_argument(hostile).unwrap_err();
            assert!(error.contains("line breaks"), "{error}");
            assert!(windows_cmd_command_line(None, "a.cmd", &[hostile], false).is_err());
        }
        assert!(windows_cmd_command_line(None, "a.cmd", &["fine"], false).is_ok());
    }

    #[test]
    fn windows_terminal_refuses_characters_it_cannot_protect() {
        assert!(validate_windows_terminal_batch_arguments(&["web", "--port", "8080", "two words", "fix the bug."])
            .is_ok());
        assert!(validate_windows_terminal_batch_arguments(&["it's", "\u{2019}", "\u{201C}x\u{201D}", "工具"]).is_ok());
        for hostile in ["& calc", "a\"b", "%PATH%", "^", "x|y", "a>b", "a<b", "(x)", "!x", "a;b", "a\nb", "a\tb"] {
            let error = validate_windows_terminal_batch_arguments(&["ok", hostile]).unwrap_err();
            assert!(error.contains("Windows Terminal"), "{hostile:?}: {error}");
        }
    }

    #[test]
    fn windows_terminal_refuses_launcher_paths_that_cmd_would_expand() {
        for good in [
            r"C:\Users\Test User\AppData\Roaming\npm\deepseek.cmd",
            r"C:\工具 目录\opencode.cmd",
            r"C:\tools\agent-1.2_x+y.bat",
        ] {
            assert!(validate_windows_terminal_batch_path(good).is_ok(), "{good}");
            assert!(!windows_batch_path_has_cmd_metacharacters(good), "{good}");
        }
        for hostile in [
            r"C:\%USERPROFILE%\agent.cmd",
            r"C:\100%\agent.cmd",
            r"C:\%COMSPEC%\agent.cmd",
            r"C:\a&calc\agent.cmd",
            r"C:\a^b\agent.cmd",
            r"C:\a|b\agent.cmd",
            r"C:\a<b\agent.cmd",
            r"C:\a>b\agent.cmd",
            r"C:\a!b\agent.cmd",
            r"C:\a;b\agent.cmd",
            r"C:\Program Files (x86)\Tool\agent.cmd",
            "C:\\a\"b\\agent.cmd",
            "C:\\a\nb\\agent.cmd",
        ] {
            let error = validate_windows_terminal_batch_path(hostile).unwrap_err();
            assert!(error.contains("Windows Terminal") && error.contains("path"), "{hostile}: {error}");
            assert!(windows_batch_path_has_cmd_metacharacters(hostile), "{hostile}");
        }
    }

    #[test]
    fn powershell_literals_double_every_kind_of_single_quote() {
        for (input, expected) in [
            ("plain", "'plain'"),
            ("it's", "'it''s'"),
            ("", "''"),
            ("x\u{2019};Start-Process calc;\u{2019}", "'x\u{2019}\u{2019};Start-Process calc;\u{2019}\u{2019}'"),
            ("\u{2018}a\u{201A}b\u{201B}", "'\u{2018}\u{2018}a\u{201A}\u{201A}b\u{201B}\u{201B}'"),
            ("$env:USERNAME `n \"x\"", "'$env:USERNAME `n \"x\"'"),
        ] {
            assert_eq!(windows_powershell_single_quoted_literal(input), expected, "{input:?}");
        }
        // The literal must never contain a lone single quote of any kind between the delimiters.
        for hostile in ["x\u{2019};Start-Process calc;\u{2019}", "'; calc; '", "\u{201B}\u{2018}'\u{201A}"] {
            let literal = windows_powershell_single_quoted_literal(hostile);
            let body = literal.chars().collect::<Vec<_>>();
            let body = &body[1..body.len() - 1];
            let mut index = 0;
            while index < body.len() {
                if POWERSHELL_SINGLE_QUOTES.contains(&body[index]) {
                    assert_eq!(body.get(index + 1), Some(&body[index]), "{literal}");
                    index += 2;
                } else {
                    index += 1;
                }
            }
        }
    }

    #[test]
    fn batch_scripts_are_recognised_by_extension() {
        for path in ["a.cmd", "A.CMD", r"C:\x y\b.Bat", "tool.bat"] {
            assert!(is_windows_batch_script(Path::new(path)), "{path}");
        }
        for path in ["a.exe", "a", "a.cmd.exe", "a.ps1", "cmd"] {
            assert!(!is_windows_batch_script(Path::new(path)), "{path}");
        }
    }
}
