//! Valve's text KeyValues (`libraryfolders.vdf`, `appmanifest_*.acf`): just enough to read the
//! two files `steam` needs. Quoted or bare tokens, `{` `}`, `//` comments, `\\` `\"` `\n` `\t`
//! escapes; `[$WIN32]`-style conditions are skipped. Malformed text is `None`, never a panic.

/// A value: a string, or a block of key/value pairs in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kv {
    Str(String),
    Obj(Vec<(String, Kv)>),
}

impl Kv {
    /// The first value under `key` (keys compare case-insensitively, as Steam's do).
    pub fn get(&self, key: &str) -> Option<&Kv> {
        match self {
            Kv::Obj(pairs) => pairs.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
            Kv::Str(_) => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Kv::Str(s) => Some(s),
            Kv::Obj(_) => None,
        }
    }
    pub fn pairs(&self) -> &[(String, Kv)] {
        match self {
            Kv::Obj(pairs) => pairs,
            Kv::Str(_) => &[],
        }
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Open,
    Close,
    Text(String),
}

/// Nesting deeper than this is refused (the real files are three levels deep).
const MAX_DEPTH: usize = 16;

fn tokens(src: &str) -> Option<Vec<Tok>> {
    let mut out = Vec::new();
    let mut it = src.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            c if c.is_whitespace() => {}
            '{' => out.push(Tok::Open),
            '}' => out.push(Tok::Close),
            '/' if it.peek() == Some(&'/') => {
                for c in it.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            '[' => {
                // A platform condition such as `[$WIN32]`: not a token.
                for c in it.by_ref() {
                    if c == ']' {
                        break;
                    }
                }
            }
            '"' => {
                let mut s = String::new();
                loop {
                    match it.next()? {
                        '"' => break,
                        '\\' => match it.next()? {
                            'n' => s.push('\n'),
                            't' => s.push('\t'),
                            other => s.push(other),
                        },
                        other => s.push(other),
                    }
                }
                out.push(Tok::Text(s));
            }
            c => {
                let mut s = String::from(c);
                while let Some(&n) = it.peek() {
                    if n.is_whitespace() || matches!(n, '{' | '}' | '"') {
                        break;
                    }
                    s.push(n);
                    it.next();
                }
                out.push(Tok::Text(s));
            }
        }
    }
    Some(out)
}

/// The file's root key and its value.
pub fn parse(src: &str) -> Option<(String, Kv)> {
    let toks = tokens(src)?;
    let mut i = 0;
    let Tok::Text(key) = toks.first()? else { return None };
    i += 1;
    let v = value(&toks, &mut i, 0)?;
    Some((key.clone(), v))
}

fn value(toks: &[Tok], i: &mut usize, depth: usize) -> Option<Kv> {
    match toks.get(*i)? {
        Tok::Text(s) => {
            *i += 1;
            Some(Kv::Str(s.clone()))
        }
        Tok::Open => {
            if depth >= MAX_DEPTH {
                return None;
            }
            *i += 1;
            let mut pairs = Vec::new();
            loop {
                match toks.get(*i)? {
                    Tok::Close => {
                        *i += 1;
                        return Some(Kv::Obj(pairs));
                    }
                    Tok::Text(k) => {
                        *i += 1;
                        let v = value(toks, i, depth + 1)?;
                        pairs.push((k.clone(), v));
                    }
                    Tok::Open => return None,
                }
            }
        }
        Tok::Close => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_nested_blocks_comments_and_escapes() {
        let src = "// a comment\n\"root\"\n{\n\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t\"q\" \"say \\\"hi\\\"\"\n\tbare value [$WIN32]\n\t\"apps\"\n\t{\n\t\t\"1\"\t\"2\"\n\t}\n}\n";
        let (k, v) = parse(src).expect("parses");
        assert_eq!(k, "root");
        assert_eq!(v.get("PATH").and_then(Kv::str), Some(r"C:\Program Files (x86)\Steam"));
        assert_eq!(v.get("q").and_then(Kv::str), Some("say \"hi\""));
        assert_eq!(v.get("bare").and_then(Kv::str), Some("value"));
        assert_eq!(v.get("apps").and_then(|a| a.get("1")).and_then(Kv::str), Some("2"));
    }

    #[test]
    fn malformed_text_is_none() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("\"root\" {"), None);
        assert_eq!(parse("\"root\" { \"k\" "), None);
        assert_eq!(parse("\"root\" \"unterminated"), None);
        assert_eq!(parse("{ }"), None);
        let deep = format!("\"r\" {}{}", "{ \"k\" ".repeat(40), "}".repeat(40));
        assert_eq!(parse(&deep), None);
    }
}
