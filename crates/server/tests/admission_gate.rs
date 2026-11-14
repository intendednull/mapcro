//! The server admits by its own build's statuses, `Admit::DEPLOYED`, and nothing else
//! (docs/specs/map-state.md §4.3). `Authority::set_admit` and `Admit::READS` are public for the
//! simulation and for tests, which exercise rows before anything may write them; a server that
//! named either would store what the build before its reader can't load. This reads the server's
//! own sources: outside its test modules it may name `Admit::DEPLOYED` only, and may not build a
//! gate of its own.

use std::path::Path;

/// The names of a gate other than the build's own, found in `source` before its test module.
fn other_gates(source: &str) -> Vec<&'static str> {
    // By convention a file's tests are one `#[cfg(test)]` module at its end.
    let code = source.split("#[cfg(test)]").next().unwrap_or(source);
    // Comments may name them: they explain the rule.
    let code: String = code.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    ["set_admit", "Admit::READS", "Admit {", "unfit_undo", "apply_tx_admitted"].into_iter().filter(|name| code.contains(name)).collect()
}

fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("the server's sources") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_server_names_no_gate_but_the_deployed_one() {
    let mut files = Vec::new();
    sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    assert!(files.len() > 10, "found the server's sources: {}", files.len());
    let mut uses_deployed = false;
    for file in &files {
        let source = std::fs::read_to_string(file).expect("source");
        assert_eq!(other_gates(&source), Vec::<&str>::new(), "{}: the server admits by Admit::DEPLOYED only", file.display());
        uses_deployed |= source.contains("Admit::DEPLOYED");
    }
    assert!(uses_deployed, "the import route passes Admit::DEPLOYED");
}

#[test]
fn the_check_finds_each_way_to_another_gate_and_leaves_tests_and_comments_alone() {
    assert_eq!(other_gates("fn f(a: &mut Authority) { a.set_admit(x) }"), ["set_admit"]);
    assert_eq!(other_gates("let r = read(&b, ids, &Admit::READS);"), ["Admit::READS"]);
    assert_eq!(other_gates("let own = Admit { row: |_| Status::Live, ..Admit::DEPLOYED };"), ["Admit {"]);
    assert_eq!(other_gates("let own = Admit::DEPLOYED; own.unfit_undo;"), ["unfit_undo"]);
    assert_eq!(other_gates("apply_tx_admitted(&mut doc, &tx, &gate)"), ["apply_tx_admitted"]);
    assert_eq!(other_gates("read(&b, ids, &Admit::DEPLOYED)\n// tests pass Admit::READS\n#[cfg(test)]\nmod tests { fn f() { a.set_admit(Admit::READS) } }"), Vec::<&str>::new());
}
