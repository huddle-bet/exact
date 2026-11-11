//! A text's laid-out width, read through the element resize event: a contract lays out by
//! the width of a string in its font (the kernel's measurer, the host's on a device).
use exact_kernel::{Kernel, Offer, PropId};
use exact_runner::{DataError, DataSource, Event, Runner, Value};

struct NoData;

impl DataSource for NoData {
    fn query(&mut self, source: &str, _: &[Value]) -> Result<Value, DataError> {
        Err(DataError::UnknownSource(source.into()))
    }
}

fn boot(source: &str) -> Runner<NoData> {
    Runner::boot(contract::compile(source).unwrap(), NoData, Kernel::with_monospace(), Default::default(), "/").unwrap()
}

fn settle(r: &mut Runner<NoData>) {
    for _ in 0..8 {
        let root = r.kernel().roots()[0];
        r.kernel_mut().compute_layout(root, Offer::definite(400.0, 800.0)).unwrap();
        let due = r.resize_due(0);
        if due.is_empty() {
            return;
        }
        for (v, rect, _) in due {
            r.resize_delivered(v, rect);
            r.dispatch(v, Event::Resize(rect)).unwrap();
        }
    }
}

fn num(r: &Runner<NoData>, name: &str) -> f64 {
    r.slot(name).and_then(Value::as_number).unwrap()
}

fn text(r: &Runner<NoData>, id: &str) -> String {
    let key = r.kernel().find_by_test_id(id)[0];
    r.kernel().node_by_key(key).unwrap().props.str(PropId::Text).unwrap_or("").into()
}

fn width(r: &Runner<NoData>, id: &str) -> f32 {
    let key = r.kernel().find_by_test_id(id)[0];
    r.kernel().node_by_key(key).unwrap().frame.width
}

const MARQUEE: &str = r#"component App
  state textW = 0
  state boxW = 0
  state line = "hello world"
  action sized(w: number, h: number)
    textW = w
  action boxed(w: number, h: number)
    boxW = w
  action longer
    line = "hello world, hello world"
  view
    column width=300
      row testId="clip" resize=boxed width=100 overflow-x="hidden"
        text line testId="line" resize=sized flex-shrink=0 white-space="nowrap"
      box testId="travel" height=4 width=(max(0, textW - boxW))
      button press=longer testId="longer"
        text "longer"
"#;

/// Bug: the text reporting its clipped box (100) instead of its own width, so a marquee's
/// travel (`textW - boxW`) is 0 and a long title never scrolls; or the width staying at its
/// first value after the string changes.
#[test]
fn a_text_reports_its_own_width_beyond_the_box_that_clips_it() {
    let mut r = boot(MARQUEE);
    settle(&mut r);
    let own = f64::from(width(&r, "line"));
    assert!(own > 100.0, "the text is wider than its clip: {own}");
    assert_eq!(num(&r, "boxW"), 100.0);
    assert!((num(&r, "textW") - own).abs() < 1e-3);
    assert!((f64::from(width(&r, "travel")) - (own - 100.0)).abs() < 1e-3, "travel = textW - boxW");
    let button = r.kernel().node_by_key(r.kernel().find_by_test_id("longer")[0]).unwrap().id;
    r.dispatch(button, Event::Press).unwrap();
    settle(&mut r);
    assert!(num(&r, "textW") > own * 2.0 - 1.0, "a longer string measures longer: {}", num(&r, "textW"));
    assert!((f64::from(width(&r, "travel")) - (num(&r, "textW") - 100.0)).abs() < 1e-3);
}

const INITIALS: &str = r#"component App
  state nameW = 0
  state colW = 0
  action named(w: number, h: number)
    nameW = w
  action cell(w: number, h: number)
    colW = w
  view
    column width=400
      column testId="cell" width=80 resize=cell
        text (colW > 0 and nameW > colW ? "AH" : "Alexander Hamilton") testId="shown" white-space="nowrap"
      text "Alexander Hamilton" resize=named position="absolute" visibility="hidden" white-space="nowrap"
"#;

/// Bug: a hidden measuring text delivering no size (so the fallback never engages), or the
/// fallback judged before the sizes arrive (a first frame showing the full name).
#[test]
fn a_name_falls_back_to_initials_when_a_hidden_copy_is_wider_than_its_column() {
    let mut r = boot(INITIALS);
    settle(&mut r);
    assert!(num(&r, "nameW") > 80.0 && num(&r, "colW") == 80.0, "{} {}", num(&r, "nameW"), num(&r, "colW"));
    assert_eq!(text(&r, "shown"), "AH");
    assert_eq!(width(&r, "cell"), 80.0);
}
