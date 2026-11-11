//! `popoverLevel` says where an open popover paints: `page` or `window`.

fn compile(level: &str) -> Result<(), String> {
    contract::compile(&format!(
        "component App\n  view\n    column\n      box id=\"burst\" popover=\"manual\" popoverLevel=\"{level}\"\n        text \"x\"\n"
    ))
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Bug: the attribute unknown to the compiler (the burst's author cannot ask for the
/// window), or any word taken (a typo silently paints under the sheet).
#[test]
fn the_popover_level_takes_page_or_window() {
    for level in ["page", "window"] {
        compile(level).unwrap_or_else(|e| panic!("{level}: {e}"));
    }
    let error = compile("sheet").unwrap_err();
    assert!(error.contains("lower-attr-value") && error.contains("popoverLevel"), "{error}");
}
