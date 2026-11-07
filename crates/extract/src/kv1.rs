//! A minimal KeyValues1 text parser, enough for Source localisation files.
//!
//! The grammar is the classic Valve KeyValues shape: a key followed by either a quoted string or
//! a `{ ... }` block. Comments (`// ...`) and a UTF-8 BOM are ignored. Quoted strings understand
//! the usual `\n`, `\t`, `\r`, `\"` and `\\` escapes.

use std::collections::BTreeMap;

use crate::{Error, Result};

/// A parsed KeyValues1 value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kv1Value {
    String(String),
    Block(Vec<(String, Kv1Value)>),
}

/// Parse a complete KeyValues1 document.
pub fn parse(text: &str) -> Result<Kv1Value> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut parser = Parser {
        chars: text.chars().collect(),
        position: 0,
    };
    let value = if parser.peek() == Some('{') {
        parser.parse_block()?
    } else {
        let key = parser.parse_string()?;
        let value = parser.parse_value()?;
        Kv1Value::Block(vec![(key, value)])
    };
    parser.skip_trivia();
    if parser.position != parser.chars.len() {
        return Err(Error::Kv1Trailing);
    }
    Ok(value)
}

/// Flatten every `key value` pair in a document into a map. Later duplicates win.
///
/// Localisation files nest their tokens under a `Tokens` block; this deliberately walks the whole
/// tree so a slightly different nesting still yields the tokens.
pub fn flatten(text: &str) -> Result<BTreeMap<String, String>> {
    let value = parse(text)?;
    let mut map = BTreeMap::new();
    collect(&value, &mut map);
    Ok(map)
}

fn collect(value: &Kv1Value, map: &mut BTreeMap<String, String>) {
    if let Kv1Value::Block(entries) = value {
        for (key, entry) in entries {
            match entry {
                Kv1Value::String(text) => {
                    map.insert(key.clone(), text.clone());
                }
                Kv1Value::Block(_) => collect(entry, map),
            }
        }
    }
}

struct Parser {
    chars: Vec<char>,
    position: usize,
}

impl Parser {
    fn parse_value(&mut self) -> Result<Kv1Value> {
        self.skip_trivia();
        match self.peek() {
            Some('{') => self.parse_block(),
            Some(_) => Ok(Kv1Value::String(self.parse_string()?)),
            None => Err(Error::Kv1UnexpectedEnd),
        }
    }

    fn parse_block(&mut self) -> Result<Kv1Value> {
        self.expect('{')?;
        let mut entries = Vec::new();

        loop {
            self.skip_trivia();
            match self.peek() {
                Some('}') => {
                    self.position += 1;
                    return Ok(Kv1Value::Block(entries));
                }
                Some(_) => {
                    let key = self.parse_string()?;
                    let value = self.parse_value()?;
                    entries.push((key, value));
                }
                None => return Err(Error::Kv1UnexpectedEnd),
            }
        }
    }

    fn parse_string(&mut self) -> Result<String> {
        self.skip_trivia();
        match self.peek() {
            Some('"') => self.parse_quoted(),
            Some('{') | Some('}') | None => Err(Error::Kv1Malformed),
            Some(_) => {
                let start = self.position;
                while let Some(character) = self.peek() {
                    if character.is_whitespace() || matches!(character, '{' | '}' | '"') {
                        break;
                    }
                    self.position += 1;
                }
                if self.position == start {
                    return Err(Error::Kv1Malformed);
                }
                Ok(self.chars[start..self.position].iter().collect())
            }
        }
    }

    fn parse_quoted(&mut self) -> Result<String> {
        self.expect('"')?;
        let mut out = String::new();

        loop {
            let Some(character) = self.next() else {
                return Err(Error::Kv1UnexpectedEnd);
            };
            match character {
                '"' => return Ok(out),
                '\\' => {
                    let Some(escaped) = self.next() else {
                        return Err(Error::Kv1UnexpectedEnd);
                    };
                    match escaped {
                        'n' => out.push('\n'),
                        't' => out.push('\t'),
                        'r' => out.push('\r'),
                        '"' => out.push('"'),
                        '\\' => out.push('\\'),
                        other => out.push(other),
                    }
                }
                other => out.push(other),
            }
        }
    }

    fn skip_trivia(&mut self) {
        loop {
            while self.peek().is_some_and(char::is_whitespace) {
                self.position += 1;
            }

            if self.peek() == Some('/') && self.peek_at(1) == Some('/') {
                while self.peek().is_some_and(|character| character != '\n') {
                    self.position += 1;
                }
                continue;
            }

            if self.peek() == Some('/') && self.peek_at(1) == Some('*') {
                self.position += 2;
                while self.position < self.chars.len() {
                    if self.peek() == Some('*') && self.peek_at(1) == Some('/') {
                        self.position += 2;
                        break;
                    }
                    self.position += 1;
                }
                continue;
            }

            break;
        }
    }

    fn expect(&mut self, expected: char) -> Result<()> {
        if self.peek() == Some(expected) {
            self.position += 1;
            Ok(())
        } else {
            Err(Error::Kv1Malformed)
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.position).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.position + offset).copied()
    }

    fn next(&mut self) -> Option<char> {
        let character = self.peek()?;
        self.position += 1;
        Some(character)
    }
}
