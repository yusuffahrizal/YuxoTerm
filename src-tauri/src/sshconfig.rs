//! Lists the hosts defined in `~/.ssh/config` so the new-tab menu can offer them.
//! Only aliases are read; `ssh` itself resolves HostName, ProxyJump, keys and
//! forwards when the tab starts, so none of that is reimplemented here.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_INCLUDE_DEPTH: usize = 5;

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Default)]
pub struct SshHost {
    pub alias: String,
    pub hostname: String,
    pub user: String,
}

/// An alias `ssh` can safely be given as its destination: no wildcards, and
/// never something that would be read as an option.
pub fn valid_alias(alias: &str) -> bool {
    !alias.is_empty()
        && !alias.starts_with('-')
        && !alias.starts_with('!')
        && !alias.contains(|c: char| c.is_whitespace() || c.is_control() || matches!(c, '*' | '?'))
}

#[tauri::command]
pub async fn ssh_hosts() -> Vec<SshHost> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        parse_file(&home.join(".ssh/config"), &home.join(".ssh"), 0)
    })
    .await
    .unwrap_or_default()
}

fn parse_file(path: &Path, base: &Path, depth: usize) -> Vec<SshHost> {
    match fs::read_to_string(path) {
        Ok(text) => parse(&text, base, depth),
        Err(_) => Vec::new(),
    }
}

/// `base` is where relative `Include` paths are resolved (`~/.ssh`).
fn parse(text: &str, base: &Path, depth: usize) -> Vec<SshHost> {
    let mut hosts: Vec<SshHost> = Vec::new();
    // Indexes into `hosts` that the current `Host` block's options apply to.
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = split_directive(line);
        match key.to_ascii_lowercase().as_str() {
            "host" => {
                current.clear();
                for alias in words(value) {
                    // Wildcards and negations are patterns, not hosts you can connect to by name.
                    if !valid_alias(&alias) || hosts.iter().any(|h| h.alias == alias) {
                        continue;
                    }
                    hosts.push(SshHost {
                        alias,
                        ..Default::default()
                    });
                    current.push(hosts.len() - 1);
                }
            }
            "match" => current.clear(),
            "hostname" => set_field(&mut hosts, &current, value, |h| &mut h.hostname),
            "user" => set_field(&mut hosts, &current, value, |h| &mut h.user),
            "include" if depth < MAX_INCLUDE_DEPTH => {
                for pattern in words(value) {
                    for file in expand_include(&pattern, base) {
                        for host in parse_file(&file, base, depth + 1) {
                            if !hosts.iter().any(|h| h.alias == host.alias) {
                                hosts.push(host);
                            }
                        }
                    }
                }
                // Anything after an Include belongs to whatever block was open before it; the
                // indexes in `current` stay valid because hosts are only appended.
            }
            _ => {}
        }
    }
    hosts
}

fn set_field(hosts: &mut [SshHost], current: &[usize], value: &str, field: fn(&mut SshHost) -> &mut String) {
    let value = words(value).into_iter().next().unwrap_or_default();
    for &i in current {
        let slot = field(&mut hosts[i]);
        // ssh uses the first value it finds for an option.
        if slot.is_empty() {
            *slot = value.clone();
        }
    }
}

/// `Keyword value` or `Keyword=value`.
fn split_directive(line: &str) -> (&str, &str) {
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let (key, rest) = line.split_at(end);
    (
        key,
        rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim(),
    )
}

/// Whitespace-separated words, with double quotes grouping.
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                any = true;
            }
            c if c.is_whitespace() && !quoted => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            c => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        out.push(cur);
    }
    out
}

fn expand_include(pattern: &str, base: &Path) -> Vec<PathBuf> {
    let path = match pattern.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None if Path::new(pattern).is_absolute() => PathBuf::from(pattern),
        None => base.join(pattern),
    };
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else {
        return Vec::new();
    };
    if !name.contains(['*', '?']) {
        return vec![path];
    }
    // Wildcards are supported in the file name only, which covers `config.d/*`.
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| wildcard(name, n))
        })
        .collect();
    files.sort();
    files
}

/// Matches `*` (any run) and `?` (any one character).
fn wildcard(pattern: &str, text: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), text.chars().collect());
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aliases(hosts: &[SshHost]) -> Vec<&str> {
        hosts.iter().map(|h| h.alias.as_str()).collect()
    }

    #[test]
    fn reads_alias_hostname_and_user() {
        let hosts = parse(
            "Host web\n  HostName 10.0.0.1\n  User deploy\n  LocalForward 5433 127.0.0.1:5432\nHost db\n  HostName=10.0.0.2\n",
            Path::new("/nonexistent"),
            0,
        );
        assert_eq!(
            hosts,
            vec![
                SshHost {
                    alias: "web".into(),
                    hostname: "10.0.0.1".into(),
                    user: "deploy".into()
                },
                SshHost {
                    alias: "db".into(),
                    hostname: "10.0.0.2".into(),
                    user: String::new()
                },
            ]
        );
    }

    #[test]
    fn skips_wildcards_negations_comments_and_option_lookalikes() {
        let text = "#Host old\nHost *\n  User root\nHost *.corp !bad ok -oProxyCommand=x\nHost a?\n";
        assert_eq!(aliases(&parse(text, Path::new("/nonexistent"), 0)), ["ok"]);
    }

    #[test]
    fn several_aliases_on_one_line_share_options() {
        let hosts = parse("Host a b \"c d\"\n  User me\n", Path::new("/nonexistent"), 0);
        // "c d" is a quoted alias with a space, which can't be passed to ssh safely.
        assert_eq!(aliases(&hosts), ["a", "b"]);
        assert!(hosts.iter().all(|h| h.user == "me"));
    }

    #[test]
    fn match_blocks_do_not_leak_options_into_hosts() {
        let hosts = parse(
            "Host a\n  User me\nMatch host a\n  User other\nHost b\n",
            Path::new("/nonexistent"),
            0,
        );
        assert_eq!(hosts[0].user, "me");
        assert_eq!(hosts[1].user, "");
    }

    #[test]
    fn first_definition_of_an_alias_wins() {
        let hosts = parse(
            "Host a\n  HostName one\nHost a\n  HostName two\n",
            Path::new("/nonexistent"),
            0,
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].hostname, "one");
    }

    #[test]
    fn follows_includes_with_wildcards() {
        let dir = std::env::temp_dir().join(format!("yuxoterm-ssh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("config.d")).unwrap();
        fs::write(dir.join("config.d/work"), "Host w1\n  User u\n").unwrap();
        fs::write(dir.join("config.d/other.txt"), "Host skipped\n").unwrap();
        fs::write(dir.join("extra"), "Host e1\n").unwrap();
        let hosts = parse("Include config.d/work extra\nHost main\n", &dir, 0);
        assert_eq!(aliases(&hosts), ["w1", "e1", "main"]);
        assert_eq!(hosts[0].user, "u");
        let globbed = parse("Include config.d/w*\n", &dir, 0);
        assert_eq!(aliases(&globbed), ["w1"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn include_cycles_terminate() {
        let dir = std::env::temp_dir().join(format!("yuxoterm-ssh-cycle-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("loop"), "Include loop\nHost l\n").unwrap();
        assert_eq!(aliases(&parse("Include loop\n", &dir, 0)), ["l"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard("*", "anything"));
        assert!(wildcard("a*c", "abbbc"));
        assert!(wildcard("a?c", "abc"));
        assert!(!wildcard("a?c", "ac"));
        assert!(!wildcard("*.conf", "file.txt"));
    }

    #[test]
    fn alias_validation() {
        assert!(valid_alias("prod-1.example"));
        assert!(!valid_alias("-oProxyCommand=x"));
        assert!(!valid_alias("a b"));
        assert!(!valid_alias("web*"));
        assert!(!valid_alias(""));
    }
}
