//! A pager: a horizontal scroller that snaps to its pages, and the fractional page
//! offset (`scrollLeft / clientWidth`) its `scroll` handler reads while the finger moves.
use exact_kernel::Kernel;
use exact_runner::{DataError, DataSource, Event, Runner, ScrollEvent, Value};

struct NoData;

impl DataSource for NoData {
    fn query(&mut self, source: &str, _: &[Value]) -> Result<Value, DataError> {
        Err(DataError::UnknownSource(source.into()))
    }
}

const PAGER: &str = r#"component App
  state offset = 0
  state page = 0
  action moved(x: number, y: number, e: ScrollEvent)
    offset = e.scrollLeft / e.clientWidth
    page = round(e.scrollLeft / e.clientWidth)
  view
    scroll id="pager" scroll=moved width=300 height=100 overflow-x="scroll" overflow-y="hidden" scroll-snap-type="x mandatory" scrollbar-width="none"
      row width=900 height=100
        for n in [0, 1, 2] key=n
          box width=300 height=100 flex-shrink=0 scroll-snap-align="start" scroll-snap-stop="always"
            text `p${n}`
"#;

fn scroll_to(r: &mut Runner<NoData>, left: f64) {
    let key = r.kernel().find_by_id("pager")[0];
    let view = r.kernel().arena().local_id(key.index);
    let event = ScrollEvent { left, top: 0.0, width: 900.0, height: 100.0, client_width: 300.0, client_height: 100.0 };
    r.dispatch(view, Event::Scroll(event)).unwrap();
}

/// Bug: the handler hearing only the whole-page offset (a rounded or stale value),
/// so a title that crossfades with the finger would jump at the page edge; or a
/// pager attribute refused by the compiler.
#[test]
fn the_scroll_handler_reads_the_fractional_page_while_the_finger_moves() {
    let mut r = Runner::boot(contract::compile(PAGER).unwrap(), NoData, Kernel::with_monospace(), Default::default(), "/").unwrap();
    for (left, offset, page) in [(0.0, 0.0, 0.0), (120.0, 0.4, 0.0), (180.0, 0.6, 1.0), (300.0, 1.0, 1.0), (750.0, 2.5, 3.0)] {
        scroll_to(&mut r, left);
        assert_eq!(r.slot("offset").and_then(Value::as_number), Some(offset), "offset at {left}");
        assert_eq!(r.slot("page").and_then(Value::as_number), Some(page), "page at {left}");
    }
}
