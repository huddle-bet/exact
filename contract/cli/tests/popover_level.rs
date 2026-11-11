fn compile(level: &str) -> Result<(), String> {
    contract::compile(&format!(
        "component App\n  view\n    column\n      box id=\"burst\" popover=\"manual\" popoverLevel=\"{level}\"\n        text \"x\"\n"
    ))
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[test]
fn the_popover_level_takes_page_or_window() {
    for level in ["page", "window"] {
        compile(level).unwrap_or_else(|e| panic!("{level}: {e}"));
    }
    let error = compile("sheet").unwrap_err();
    assert!(error.contains("lower-attr-value") && error.contains("popoverLevel"), "{error}");
}
