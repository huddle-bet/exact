use exact_apple::Host;
use exact_kernel::MonospaceMeasurer;
use exact_runner::{DataError, DataSource, Event, Value};

struct NoData;
impl DataSource for NoData {
    fn query(&mut self, s: &str, _: &[Value]) -> Result<Value, DataError> {
        Err(DataError::UnknownSource(s.into()))
    }
}

const APP: &str = r#"routes nav
  home "/"
    detail "/detail"

keyframes leave
  to opacity=0

component App
  action open
    nav = push(nav, "/detail")
  action back
    nav = back(nav)
  view
    main navigationKey=`${top(nav).id}` navigationBack="back" width="100%" height="100%"
      for e in stack(nav) key=e.id
        if e.name == "home"
          column navigationKey=`${e.id}` position="absolute" inset=0 testId="home" -exact-exit-animation=EXIT
            button press=open testId="open"
              text "Open"
        if e.name == "detail"
          column navigationKey=`${e.id}` position="absolute" inset=0 testId="detail"
            button press=back testId="back"
              text "Back"
"#;

fn view(host: &Host<NoData>, test_id: &str) -> Option<u32> {
    let k = host.runner().kernel();
    let key = *k.find_by_test_id(test_id).first()?;
    Some(k.node_by_key(key).unwrap().id)
}

fn boot(exit: &str) -> Host<NoData> {
    let plan = contract::compile(&APP.replace("EXIT", &format!("\"{exit}\""))).unwrap();
    Host::boot(
        &plan.encode(),
        NoData,
        Box::new(MonospaceMeasurer::default()),
        390.0,
        844.0,
    )
    .unwrap()
    .0
}

fn specs(batch: &str, id: u32) -> Option<String> {
    let marker = format!("{{\"op\":\"animations\",\"id\":{id},\"specs\":");
    let at = batch.rfind(&marker)? + marker.len();
    let end = batch[at..].find("]}")? + 1;
    Some(batch[at..at + end].to_string())
}

#[test]
fn a_covered_route_plays_its_exit_as_core_animation_specs() {
    let mut host = boot("leave 200ms linear both");
    let (home, open) = (view(&host, "home").unwrap(), view(&host, "open").unwrap());
    let pushed = host.dispatch_at(open, Event::Press, 100.0);
    let s = specs(&pushed, home).unwrap_or_else(|| panic!("no specs for the route: {pushed}"));
    assert!(s.contains("\"opacity\""), "{s}");
    assert!(
        s.contains("\"d\":0.2") && s.contains("\"v\":[1,0]") && s.contains("\"fill\":3"),
        "{s}"
    );
    assert!(
        !pushed.contains(&format!("{{\"op\":\"exit\",\"id\":{home}}}"))
            && !pushed.contains(&format!("{{\"op\":\"destroy\",\"id\":{home}}}")),
        "the route stays mounted: {pushed}"
    );
}

#[test]
fn back_takes_the_exit_off_the_route() {
    let mut host = boot("leave 200ms linear both");
    let (home, open) = (view(&host, "home").unwrap(), view(&host, "open").unwrap());
    host.dispatch_at(open, Event::Press, 100.0);
    let back = view(&host, "back").unwrap();
    let popped = host.dispatch_at(back, Event::Press, 150.0);
    assert_eq!(specs(&popped, home).as_deref(), Some("[]"), "{popped}");
}

#[test]
fn a_route_with_no_exit_row_is_left_alone() {
    let mut host = boot("none");
    let (home, open) = (view(&host, "home").unwrap(), view(&host, "open").unwrap());
    let pushed = host.dispatch_at(open, Event::Press, 100.0);
    assert!(specs(&pushed, home).is_none(), "{pushed}");
}
