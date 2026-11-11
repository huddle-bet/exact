const SOURCE: &str = "shape Item\n  name: string\ncomponent App\n  resource ids = ids() as shape string[]\n  resource details = detail(id) for id in ids key=id as shape Item\n  view\n    Row(items=details)\ncomponent Row\n  props\n    items: Item[]\n  view\n    for item in items key=item.name\n      text item.nmae\n";

#[test]
fn a_for_resource_passed_to_a_list_prop_reports_only_the_real_error() {
    let root = std::env::temp_dir().join(format!("exact-for-resource-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("app.contract");
    std::fs::write(&path, SOURCE).unwrap();
    let first = contract::compile_path(&path).unwrap_err();
    assert_eq!(first.id, "type-unknown-field", "{first}");
    let all = match contract::compile_path_all(&path, false) {
        Ok(_) => panic!("compiled"),
        Err(e) => e,
    };
    let ids: Vec<&str> = all.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(ids, ["type-unknown-field"], "{all:?}");
}
