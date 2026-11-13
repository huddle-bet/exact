//! `exact-model`, the package view of `@exact/model`, through its real `exact.json`: every prop it
//! declares compiles on the tag (none is a name Contract takes for the box) and reaches the
//! implementation as JSON under its name, a prop is held to its declared type, and the events it
//! sends run their handlers.

use exact_kernel::PropId;
use exact_runner::{Event, Runner, Value};
use serde_json::json;
use std::path::PathBuf;

const INTERFACE: &str = include_str!("../../../../packages/model/exact.json");

const APP: &str = r#"use ModelLight, ModelTexture, ModelSheen, ModelScreen, ModelPose from "@exact/model"

component App
  state yaw = 16
  state status = "waiting"
  state settled = 0
  derive lights = [ModelLight(yaw=-34.7, pitch=18, intensity=0.67, kelvin=6500), ModelLight(yaw=160, pitch=-15, intensity=0.57, kelvin=5500)]
  derive pictures = [ModelTexture(node="Screen", source="assets/home.jpg")]
  derive bands = [ModelSheen(at=0, width=0.12, peak=0.06)]
  derive hidden = ["ScreenApp"]
  derive next = ModelPose(yaw=-9, pitch=-2, roll=0, scale=1, offsetX=0, offsetY=0)
  action ready
    status = "drawn"
  action broke(why: string)
    status = why
  action placed(s: ModelScreen)
    status = s.rotate
  action arrived
    settled = settled + 1
  view
    column
      exact-model testId="phone" source="assets/phone.glb" environment="assets/studio.ktx" ambient=0.768 lights=lights fov=24 distance=0.503 viewFill=0.74 yaw=yaw pitch=-2 roll=0 modelScale=1 offsetX=0 offsetY=0 response=850 sway=2.5 swayMs=5200 tilt=1 tiltGain=0.5 tiltMaxDeg=6 tiltStiffness=70 tiltDamping=15 tiltRecenter=0.02 textures=pictures hiddenNodes=hidden sheen=bands sheenStrength=1.05 sheenRest=-0.6 sheenYaw=4 sheenPitch=3 load=ready failed=broke settled=arrived screen=placed screenNode="Screen" screenWidth=420 screenHeight=912 leanTo=next leanBy=0.3 width=300 height=600
"#;

struct App(PathBuf);
impl App {
    fn new(name: &str, app: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("exact-model-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let at = path.join("node_modules/@exact/model");
        std::fs::create_dir_all(&at).unwrap();
        let manifest = json!({ "name": "@exact/model", "version": "1.0.0", "exports": { ".": "./exact.json" } });
        std::fs::write(at.join("package.json"), manifest.to_string()).unwrap();
        std::fs::write(at.join("exact.json"), INTERFACE).unwrap();
        let manifest = json!({ "name": "app", "dependencies": { "@exact/model": "1.0.0" } });
        std::fs::write(path.join("package.json"), manifest.to_string()).unwrap();
        std::fs::write(path.join("app.contract"), app).unwrap();
        Self(path.canonicalize().unwrap())
    }
    fn compile(&self) -> Result<exact_plan::Plan, Vec<contract::CompileError>> {
        contract::compile_path_all(&self.0.join("app.contract"), false).map(|(plan, _)| plan)
    }
}
impl Drop for App {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct NoData;
impl exact_runner::DataSource for NoData {
    fn query(&mut self, source: &str, _: &[Value]) -> Result<Value, exact_runner::DataError> {
        Err(exact_runner::DataError::UnknownSource(source.into()))
    }
}

fn boot(app: &App) -> Runner<NoData> {
    Runner::boot(
        app.compile().unwrap_or_else(|e| panic!("{e:?}")),
        NoData,
        exact_kernel::Kernel::with_monospace(),
        Default::default(),
        "/",
    )
    .unwrap()
}

fn props(r: &Runner<NoData>) -> serde_json::Value {
    let key = r.kernel().find_by_test_id("phone")[0];
    let node = r.kernel().node_by_key(key).unwrap();
    serde_json::from_str(node.props.str(PropId::NativeViewProps).unwrap()).unwrap()
}

/// A declared prop named like a known attribute (`scale`, `hidden`, `src`) would bind to the box and
/// never reach the implementation: compiling every prop is the catch, and the JSON names each.
#[test]
fn every_declared_prop_reaches_the_view_under_its_name() {
    let r = boot(&App::new("props", APP));
    let p = props(&r);
    let declared: Vec<String> = serde_json::from_str::<serde_json::Value>(INTERFACE).unwrap()
        ["views"]["exact-model"]["props"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    for name in &declared {
        assert!(
            p.get(name).is_some(),
            "`{name}` did not reach the view; it holds {p}"
        );
    }
    assert_eq!(p.as_object().unwrap().len(), declared.len(), "{p}");
    assert_eq!(p["source"], "assets/phone.glb");
    assert_eq!(p["yaw"], "16");
    let lights: serde_json::Value = serde_json::from_str(p["lights"].as_str().unwrap()).unwrap();
    assert_eq!(
        lights,
        json!([
            { "yaw": -34.7, "pitch": 18, "intensity": 0.67, "kelvin": 6500 },
            { "yaw": 160, "pitch": -15, "intensity": 0.57, "kelvin": 5500 }
        ])
    );
    let hidden: serde_json::Value =
        serde_json::from_str(p["hiddenNodes"].as_str().unwrap()).unwrap();
    assert_eq!(hidden, json!(["ScreenApp"]));
    let pictures: serde_json::Value =
        serde_json::from_str(p["textures"].as_str().unwrap()).unwrap();
    assert_eq!(
        pictures,
        json!([{ "node": "Screen", "source": "assets/home.jpg" }])
    );
}

/// A pose bound to state moves the view's prop: the tour changes `yaw` per card.
#[test]
fn a_pose_prop_follows_the_state_it_is_bound_to() {
    let mut r = boot(&App::new("pose", &APP.replace("    column\n      exact-model", "    column\n      button press=turn testId=\"turn\"\n        text \"turn\"\n      exact-model").replace("  action ready", "  action turn\n    yaw = -9\n  action ready")));
    assert_eq!(props(&r)["yaw"], "16");
    r.act("turn", Vec::new()).unwrap();
    assert_eq!(props(&r)["yaw"], "-9");
}

#[test]
fn a_prop_is_held_to_its_declared_type() {
    for (from, to, name) in [
        ("fov=24", "fov=\"wide\"", "fov"),
        ("lights=lights", "lights=first(lights)", "lights"),
        ("hiddenNodes=hidden", "hiddenNodes=3", "hiddenNodes"),
    ] {
        let refused = App::new("wrong", &APP.replace(from, to))
            .compile()
            .unwrap_err();
        assert!(
            refused
                .iter()
                .any(|e| e.id == "contract-view-prop" && e.message.contains(&format!("`{name}`"))),
            "{name}: {refused:?}"
        );
    }
}

/// `load` is the box's, `failed` and `settled` the package's: each runs its action, `failed` with the reason sent.
#[test]
fn load_failed_and_settled_run_their_handlers() {
    let mut r = boot(&App::new("events", APP));
    let key = r.kernel().find_by_test_id("phone")[0];
    let id = r.kernel().node_by_key(key).unwrap().id;
    r.dispatch(id, Event::Load).unwrap();
    assert_eq!(r.slot("status"), Some(&Value::str("drawn")));
    let sent = json!({ "exact:event": "failed", "args": ["phone.glb: HTTP 404"] });
    r.dispatch(id, Event::Message(sent.to_string())).unwrap();
    assert_eq!(r.slot("status"), Some(&Value::str("phone.glb: HTTP 404")));
    let sent = json!({ "exact:event": "settled", "args": [] });
    r.dispatch(id, Event::Message(sent.to_string())).unwrap();
    assert_eq!(r.slot("settled"), Some(&Value::Number(1.0)));
}

const LIVE: &str = r#"use ModelScreen from "@exact/model"

component App
  state perspective = 0
  state translate = "0px 0px 0px"
  state rotate = "0deg"
  state scale = 1
  state facing = false
  action placed(s: ModelScreen)
    perspective = s.perspective
    translate = s.translate
    rotate = s.rotate
    scale = s.scale
    facing = s.facing
  view
    column width=420 height=700 position="relative"
      exact-model testId="phone" source="assets/phone.glb" screenNode="Screen" screen=placed width=420 height=700
      column testId="stage" position="absolute" left=0 top=0 width=420 height=700 perspective=perspective
        column testId="live" position="absolute" left=0 top=0 width=420 height=912 translate=translate rotate=rotate scale=scale display=(facing ? "flex" : "none")
          text "live"
"#;

fn live(r: &Runner<NoData>) -> (f32, [f32; 2], f32, f32, f32) {
    let key = r.kernel().find_by_test_id("live")[0];
    let node = r.kernel().node_by_key(key).unwrap();
    let parent = r
        .kernel()
        .node_by_key(r.kernel().find_by_test_id("stage")[0])
        .unwrap();
    (
        parent.style.perspective,
        [node.style.translate.x, node.style.translate.y],
        node.style.translate_z,
        node.style.rotate,
        node.style.scale,
    )
}

/// The view sends the CSS that lays a box over the model's screen as the model moves. A child bound to it
/// takes its perspective, translate, rotate and scale from each event, the way the app's live screen
/// follows RN's projected quad. A `screen` event that did not reach the child's rows leaves the live
/// screen where the first pose put it.
#[test]
fn a_child_follows_the_screen_the_view_reports() {
    let mut r = boot(&App::new("live", LIVE));
    assert_eq!(live(&r).0, 0.0);
    let key = r.kernel().find_by_test_id("phone")[0];
    let id = r.kernel().node_by_key(key).unwrap().id;
    let send = |r: &mut Runner<NoData>, screen: serde_json::Value| {
        let sent = json!({ "exact:event": "screen", "args": [screen] });
        r.dispatch(id, Event::Message(sent.to_string())).unwrap();
    };
    send(
        &mut r,
        json!({ "perspective": 1900.5, "translate": "12px -30px 0px", "rotate": "0 1 0 16deg", "scale": 0.42, "facing": true, "quad": [0, 0, 0, 0, 0, 0, 0, 0] }),
    );
    let (perspective, [x, y], z, turn, scale) = live(&r);
    assert_eq!(
        (perspective, x, y, z, scale),
        (1900.5, 12.0, -30.0, 0.0, 0.42)
    );
    assert_eq!(turn, 16.0);
    send(
        &mut r,
        json!({ "perspective": 1900.5, "translate": "-8px 4px 0px", "rotate": "0 1 0 -9deg", "scale": 0.4, "facing": true, "quad": [0, 0, 0, 0, 0, 0, 0, 0] }),
    );
    let (_, [x, y], _, turn, scale) = live(&r);
    assert_eq!((x, y, turn, scale), (-8.0, 4.0, -9.0, 0.4));
}

const CHILD: &str = r#"use ModelScreen from "@exact/model"

component App
  state seen = ""
  view
    column
      Phone(tag="a")
      Phone(tag="b")
      text seen

component Phone
  props
    tag: string
  state last = ""
  action placed(s: ModelScreen)
    last = tag + s.rotate
  view
    exact-model testId=tag source="assets/phone.glb" screenNode="Screen" screen=placed width=100 height=100
    column testId=(tag + "-last") display=(last == tag + (tag == "a" ? "1deg" : "2deg") ? "flex" : "none")
"#;

#[test]
fn a_child_binds_a_view_event_to_its_own_action() {
    let mut r = boot(&App::new("child", CHILD));
    for (tag, rotate) in [("a", "1deg"), ("b", "2deg")] {
        let key = r.kernel().find_by_test_id(tag)[0];
        let id = r.kernel().node_by_key(key).unwrap().id;
        let screen = json!({ "perspective": 1.0, "translate": "0px", "rotate": rotate, "scale": 1.0, "facing": true, "quad": [0, 0, 0, 0, 0, 0, 0, 0] });
        let sent = json!({ "exact:event": "screen", "args": [screen] });
        r.dispatch(id, Event::Message(sent.to_string())).unwrap();
    }
    for tag in ["a", "b"] {
        let k = r.kernel().find_by_test_id(&format!("{tag}-last"))[0];
        let shown = r.kernel().node_by_key(k).unwrap().style.display;
        assert_eq!(shown, exact_kernel::Display::Flex, "{tag}");
    }
}
