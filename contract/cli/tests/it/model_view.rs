//! `exact-model`, the package view of `@exact/model`, through its real `exact.json`: every prop it
//! declares compiles on the tag (none is a name Contract takes for the box) and reaches the
//! implementation as JSON under its name, a prop is held to its declared type, and the events it
//! sends run their handlers.

use exact_kernel::PropId;
use exact_runner::{Event, Runner, Value};
use serde_json::json;
use std::path::PathBuf;

const INTERFACE: &str = include_str!("../../../../packages/model/exact.json");

const APP: &str = r#"use ModelLight, ModelTexture, ModelSheen from "@exact/model"

component App
  state yaw = 16
  state status = "waiting"
  state settled = 0
  derive lights = [ModelLight(yaw=-34.7, pitch=18, intensity=0.67, kelvin=6500), ModelLight(yaw=160, pitch=-15, intensity=0.57, kelvin=5500)]
  derive pictures = [ModelTexture(node="Screen", source="assets/home.jpg")]
  derive bands = [ModelSheen(at=0, width=0.12, peak=0.06)]
  derive hidden = ["ScreenApp"]
  action ready
    status = "drawn"
  action broke(why: string)
    status = why
  action arrived
    settled = settled + 1
  view
    column
      exact-model testId="phone" source="assets/phone.glb" environment="assets/studio.ktx" ambient=0.768 lights=lights fov=24 distance=0.503 viewFill=0.74 yaw=yaw pitch=-2 roll=0 modelScale=1 offsetX=0 offsetY=0 response=850 sway=2.5 swayMs=5200 tilt=1 tiltGain=0.5 tiltMaxDeg=6 tiltStiffness=70 tiltDamping=15 tiltRecenter=0.02 textures=pictures hiddenNodes=hidden sheen=bands sheenStrength=1.05 sheenRest=-0.6 sheenYaw=4 sheenPitch=3 load=ready failed=broke settled=arrived width=300 height=600
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
