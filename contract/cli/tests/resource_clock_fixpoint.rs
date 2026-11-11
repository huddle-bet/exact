const SOURCE: &str = r#"
fn outer(): number = inner()
fn inner(): number = performanceNow()
shape Reply
  value: number
component App
  state sampledAt = 0
  derive c = b
  derive b = a
  derive a = outer() + 1
  derive quiet = sampledAt + 1
  resource first = read(c) as shape Reply else empty()
  resource second = read(quiet) as shape Reply else empty()
  resource third = read(outer()) as shape Reply else empty()
  view
    text first.value
"#;

#[test]
fn clock_warnings_settle_through_reverse_ordered_derives_and_functions() {
    let file = contract_syntax::parse(SOURCE).unwrap();
    let warnings = contract_analyze::resource_clock_warnings(&file);
    let names: Vec<bool> = ["`first`", "`second`", "`third`"]
        .iter()
        .map(|n| warnings.iter().any(|w| w.message.contains(n)))
        .collect();
    assert_eq!(names, [true, false, true], "{warnings:?}");
    assert_eq!(warnings.len(), 2);
    assert!(warnings.iter().all(|w| w.id == "analyze-resource-clock"));
}
