//! Schema probe: every networked class's field paths (recursively, from the send tables) whose
//! name matches a pattern. Reads no entity data.
//! `cargo run -p mapcro-replay --release --example schema_probe -- <replay.dem> resist armor …`
use boon::Parser;
fn walk(prefix: &str, fields: &[std::sync::Arc<boon::SerializerField>], pats: &[String], class: &str, depth: usize) {
    for f in fields {
        let p = if prefix.is_empty() { f.var_name.to_string() } else { format!("{prefix}.{}", f.var_name) };
        let l = p.to_ascii_lowercase();
        if pats.iter().any(|x| l.contains(x.as_str())) { println!("{class}\t{p}\t{}", f.var_type); }
        if depth < 6 { if let Some(s) = f.field_serializer.as_ref() { walk(&p, &s.fields, pats, class, depth + 1); } }
    }
}
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let pats: Vec<String> = a[2..].iter().map(|s| s.to_ascii_lowercase()).collect();
    let s = Parser::from_file(std::path::Path::new(&a[1])).expect("opens").parse_send_tables().expect("tables");
    eprintln!("{} classes", s.len());
    for (name, ser) in s.iter() { walk("", &ser.fields, &pats, name, 0); }
}
