//! `navigationDetent`'s `fit-content(P%)`: the content's height, up to P percent of
//! the sheet's maximum. It goes where `fit-content` goes (alone, or before `large`),
//! and a dialog sheet takes it too.

fn route(value: &str) -> Result<(), String> {
    contract::compile(&format!(
        "component App\n  view\n    column navigationKey=\"a\" navigationPresentation=\"modal\" navigationDetent=\"{value}\"\n"
    ))
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Bug: a cap word read as a bare `fit-content` (cap dropped), or refused as an
/// unknown word, or let past the rule that a content height can pass every other detent.
#[test]
fn a_capped_fit_content_goes_where_fit_content_goes() {
    for value in ["fit-content(50%)", "fit-content(87.5%) large", "fit-content(100%)"] {
        route(value).unwrap_or_else(|e| panic!("{value}: {e}"));
    }
    for (value, given) in [
        ("fit-content(0%)", "fit-content(0%)"),
        ("fit-content(120%)", "fit-content(120%)"),
        ("fit-content(50)", "fit-content(50)"),
        ("fit-content(50%) 300", "fit-content(50%) 300"),
        ("fit-content(50%) fit-content", "fit-content(50%) fit-content"),
        ("large fit-content(50%)", "large fit-content(50%)"),
    ] {
        let error = route(value).unwrap_err();
        assert!(error.contains("lower-attr-value") && error.contains(&format!("given \"{given}\"")), "{value}: {error}");
    }
}

/// Bug: a dialog refusing `navigationDetent`, or taking a bad cap unchecked.
#[test]
fn a_dialog_takes_a_capped_fit_content_detent() {
    let compile = |value: &str| {
        contract::compile(&format!(
            "component App\n  view\n    dialog id=\"d\" navigationDetent=\"{value}\"\n      text \"x\"\n"
        ))
        .map(|_| ())
        .map_err(|e| e.to_string())
    };
    compile("fit-content(50%)").unwrap_or_else(|e| panic!("{e}"));
    let error = compile("fit-content(0%)").unwrap_err();
    assert!(error.contains("lower-attr-value") && error.contains("fit-content(0%)"), "{error}");
}
