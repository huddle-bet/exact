use exact_kernel::PropId;
use exact_runner::{Event, Runner, Value};
use serde_json::json;
use std::path::PathBuf;

const INTERFACE: &str = include_str!("../../../../packages/shader/exact.json");

const SOURCE: &str = "uniform shader image;\\nuniform shader huddle;\\nuniform float2 center;\\nuniform float radius;\\nuniform float power;\\nuniform float band;\\nuniform float amp;\\nuniform float spread;\\nuniform float label;\\nuniform float t;\\nhalf4 main(float2 p) { return half4(1.0); }";

const APP: &str = r#"use ShaderImage, ShaderUniform from "@exact/shader"

// cubic-bezier(0.3, 0.3, 0.45, 1), RN's EASE.wave: Newton's method on x(s) = p, four steps, then y(s).
fn bx(s: number): number = 3 * (1 - s) * (1 - s) * s * 0.3 + 3 * (1 - s) * s * s * 0.45 + s * s * s
fn dbx(s: number): number = 3 * (1 - s) * (1 - s) * 0.3 + 6 * (1 - s) * s * (0.45 - 0.3) + 3 * s * s * (1 - 0.45)
fn by(s: number): number = 3 * (1 - s) * (1 - s) * s * 0.3 + 3 * (1 - s) * s * s * 1 + s * s * s
fn newton(s: number, p: number): number = min(1, max(0, s - (bx(s) - p) / max(0.05, dbx(s))))
fn ease(p: number): number = by(newton(newton(newton(newton(p, p), p), p), p))

component App
  state running = false
  state startedAt = 0
  state progress = 0
  state status = "waiting"
  state eased = 0
  derive wave = ease(progress)
  derive images = [ShaderImage(name="image", source="assets/home-empty.jpg", sizing="cover", tile="decal"), ShaderImage(name="huddle", source="assets/home-huddle.jpg", sizing="cover", tile="decal")]
  derive uniforms = [ShaderUniform(name="center", value=[258.67, 444]), ShaderUniform(name="radius", value=[-23.6 + wave * 400]), ShaderUniform(name="power", value=[5]), ShaderUniform(name="band", value=[96]), ShaderUniform(name="amp", value=[34]), ShaderUniform(name="spread", value=[0.025]), ShaderUniform(name="label", value=[0]), ShaderUniform(name="t", value=[wave])]
  task ripple when running
    every(frame, step)
  action step
    progress = min(1, (performanceNow() - startedAt) / 2400)
    if progress >= 1
      running = false
  action start
    startedAt = performanceNow()
    running = true
  action sample(p: number)
    eased = ease(p)
  action ready
    status = "drawn"
  action broke(why: string)
    status = why
  view
    column
      button press=start testId="start"
        text "start"
      exact-shader testId="ripple" source="SOURCE" images=images uniforms=uniforms load=ready failed=broke width=420 height=912
"#;

struct App(PathBuf);
impl App {
    fn new(name: &str, app: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("exact-shader-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let at = path.join("node_modules/@exact/shader");
        std::fs::create_dir_all(&at).unwrap();
        let manifest = json!({ "name": "@exact/shader", "version": "1.0.0", "exports": { ".": "./exact.json" } });
        std::fs::write(at.join("package.json"), manifest.to_string()).unwrap();
        std::fs::write(at.join("exact.json"), INTERFACE).unwrap();
        let manifest = json!({ "name": "app", "dependencies": { "@exact/shader": "1.0.0" } });
        std::fs::write(path.join("package.json"), manifest.to_string()).unwrap();
        std::fs::write(path.join("app.contract"), app.replace("SOURCE", SOURCE)).unwrap();
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
    let key = r.kernel().find_by_test_id("ripple")[0];
    let node = r.kernel().node_by_key(key).unwrap();
    serde_json::from_str(node.props.str(PropId::NativeViewProps).unwrap()).unwrap()
}

fn uniforms(r: &Runner<NoData>) -> std::collections::BTreeMap<String, Vec<f64>> {
    let p = props(r);
    let list: Vec<serde_json::Value> =
        serde_json::from_str(p["uniforms"].as_str().unwrap()).unwrap();
    list.iter()
        .map(|u| {
            (
                u["name"].as_str().unwrap().to_string(),
                u["value"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_f64().unwrap())
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn every_declared_prop_reaches_the_view_under_its_name() {
    let r = boot(&App::new("props", APP));
    let p = props(&r);
    let declared: Vec<String> = serde_json::from_str::<serde_json::Value>(INTERFACE).unwrap()
        ["views"]["exact-shader"]["props"]
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
    assert!(p["source"]
        .as_str()
        .unwrap()
        .starts_with("uniform shader image;\nuniform shader huddle;"));
    let images: serde_json::Value = serde_json::from_str(p["images"].as_str().unwrap()).unwrap();
    assert_eq!(
        images,
        json!([
            { "name": "image", "source": "assets/home-empty.jpg", "sizing": "cover", "tile": "decal" },
            { "name": "huddle", "source": "assets/home-huddle.jpg", "sizing": "cover", "tile": "decal" }
        ])
    );
    let u = uniforms(&r);
    assert_eq!(
        u.keys().map(String::as_str).collect::<Vec<_>>(),
        ["amp", "band", "center", "label", "power", "radius", "spread", "t"]
    );
    assert_eq!(u["center"], [258.67, 444.0]);
    assert_eq!(u["power"], [5.0]);
}

#[test]
fn the_uniforms_follow_the_state_a_frame_timer_writes() {
    let mut r = boot(&App::new("timer", APP));
    assert_eq!(uniforms(&r)["radius"], [-23.6]);
    r.act("start", Vec::new()).unwrap();
    r.present_frames(true);
    let mut seen = vec![];
    for t in [600.0, 1200.0, 1800.0, 2400.0, 3000.0] {
        r.frame(t);
        seen.push(uniforms(&r)["radius"][0]);
    }
    assert!(seen.windows(2).all(|w| w[1] >= w[0]), "{seen:?}");
    assert!(seen[0] > -23.6 && seen[0] < seen[2], "{seen:?}");
    assert!(
        (seen[3] - 376.4).abs() < 1e-6 && seen[4] == seen[3],
        "it ends at progress 1 and stays: {seen:?}"
    );
}

#[test]
fn the_bezier_ease_a_contract_fn_writes_matches_the_curve() {
    let mut r = boot(&App::new("ease", APP));
    let curve = |p: f64| {
        let (x1, y1, x2, y2) = (0.3, 0.3, 0.45, 1.0);
        let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
        for _ in 0..80 {
            let s = (lo + hi) / 2.0;
            let x = 3.0 * (1.0 - s).powi(2) * s * x1 + 3.0 * (1.0 - s) * s * s * x2 + s.powi(3);
            if x < p {
                lo = s
            } else {
                hi = s
            }
        }
        let s = (lo + hi) / 2.0;
        3.0 * (1.0 - s).powi(2) * s * y1 + 3.0 * (1.0 - s) * s * s * y2 + s.powi(3)
    };
    for p in [0.0, 0.05, 0.2, 0.5, 0.8, 0.95, 1.0] {
        r.act("sample", vec![Value::Number(p)]).unwrap();
        let Some(Value::Number(got)) = r.slot("eased").cloned() else {
            panic!("no eased")
        };
        assert!(
            (got - curve(p)).abs() < 2e-3,
            "ease({p}) = {got}, the curve gives {}",
            curve(p)
        );
    }
}

#[test]
fn a_prop_is_held_to_its_declared_type() {
    for (from, to, name) in [
        ("uniforms=uniforms", "uniforms=3", "uniforms"),
        ("images=images", "images=\"home.jpg\"", "images"),
        ("source=\"SOURCE\"", "source=5", "source"),
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

#[test]
fn load_and_failed_run_their_handlers() {
    let mut r = boot(&App::new("events", APP));
    let key = r.kernel().find_by_test_id("ripple")[0];
    let id = r.kernel().node_by_key(key).unwrap().id;
    r.dispatch(id, Event::Load).unwrap();
    assert_eq!(r.slot("status"), Some(&Value::str("drawn")));
    let sent = json!({ "exact:event": "failed", "args": ["the shader did not compile: nope"] });
    r.dispatch(id, Event::Message(sent.to_string())).unwrap();
    assert_eq!(
        r.slot("status"),
        Some(&Value::str("the shader did not compile: nope"))
    );
}
