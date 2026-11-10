//! An image's `load` hands an action that takes one more parameter its
//! `ImageLoadEvent`: the natural size and where the pixels' ink sits. A load
//! that carries no pixels (an iframe's, or a host that read none) hands the
//! record with zeros.

use exact_kernel::{Kernel, PropId};
use exact_runner::{Event, Runner};

const APP: &str = r#"component App
  state seen = ""
  action read(which: string, e: ImageLoadEvent)
    seen = `${seen}${which} ${e.naturalWidth}x${e.naturalHeight} ${e.inkLeft},${e.inkTop},${e.inkRight},${e.inkBottom} ${e.inkFill} ${e.solidTop} ${e.footLeft}-${e.footRight};`
  action plain()
    seen = `${seen}plain;`
  view
    column
      image "https://example.com/face.png" width=48 height=48 load=read("face") testId="face"
      image "https://example.com/logo.png" width=48 height=48 load=plain testId="logo"
      iframe src="/deck/index.html" load=read("frame") testId="frame"
      text seen testId="seen"
"#;

fn node(r: &Runner<()>, test_id: &str) -> exact_kernel::ViewId {
    let key = r.kernel().find_by_test_id(test_id)[0];
    r.kernel().node_by_key(key).unwrap().id
}

#[test]
fn a_load_hands_its_pixels_record_to_an_action_that_takes_it() {
    let plan = contract::compile(APP).unwrap_or_else(|e| panic!("{e}"));
    let mut r = Runner::boot(plan, (), Kernel::with_monospace(), Default::default(), "/").unwrap();
    let face = node(&r, "face");
    r.dispatch(
        face,
        Event::load("260,190,0.1,0.05,0.9,1,0.81,0.08,0.2,0.8").unwrap(),
    )
    .unwrap();
    let logo = node(&r, "logo");
    r.dispatch(logo, Event::load("64,64,0,0,1,1,1,0,0,1").unwrap())
        .unwrap();
    let frame = node(&r, "frame");
    r.dispatch(frame, Event::load("").unwrap()).unwrap();
    let seen = node(&r, "seen");
    assert_eq!(
        r.kernel().node(seen).unwrap().props.str(PropId::Text),
        Some("face 260x190 0.1,0.05,0.9,1 0.81 0.08 0.2-0.8;plain;frame 0x0 0,0,0,0 0 0 0-0;")
    );
}

#[test]
fn a_load_payload_is_ten_finite_numbers_or_none() {
    assert!(matches!(Event::load(""), Some(Event::Load)));
    assert!(matches!(
        Event::load("1,2,0,0,1,1,1,0,0,1"),
        Some(Event::ImageLoad(_))
    ));
    for bad in [
        "1,2,0,0,1,1,1,0,0",
        "1,2,0,0,1,1,1,0,0,1,1",
        "1,2,0,0,1,1,1,0,0,x",
        "1,2,0,0,1,1,1,0,0,-1",
        "1,2,0,0,1,1,1,0,0,NaN",
    ] {
        assert!(Event::load(bad).is_none(), "{bad}");
    }
}
