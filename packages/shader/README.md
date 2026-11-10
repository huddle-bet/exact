# @exact/shader

`exact-shader` runs a per-pixel shader over images in its box: Metal on iOS and macOS, WebGL2 on the web. Linux, Windows,
Android, tvOS and the terminal have no implementation: the box lays out and draws nothing there and `load` never fires.

```text
use ShaderImage, ShaderUniform from "@exact/shader"

component Ripple
  state radius = 0
  derive pictures = [ShaderImage(name="image", source="assets/home-empty.jpg", sizing="cover", tile="decal")]
  derive values = [ShaderUniform(name="radius", value=[radius]), ShaderUniform(name="center", value=[258.67, 444])]
  view
    exact-shader source=WAVE images=pictures uniforms=values width=420 height=912
```

| Prop | Type | Meaning |
|---|---|---|
| `source` | string | The shader, in the language below. |
| `images` | ShaderImage[]? | One entry for each `uniform shader` the source declares: `name`, `source` (an app asset path read by the host's asset reader, or an `app:/` file), `sizing` (`cover`, the default, `contain` or `fill`), `tile` (`decal`, the default, outside the picture is transparent black; or `clamp`). |
| `uniforms` | ShaderUniform[]? | Numeric uniforms by `name`, each `value` a list of as many numbers as the declared type has (1 to 4). A uniform never set reads 0. |

Events: `load` after the first draw; `failed(reason: string)` for a shader that does not compile, an image that cannot be read, an image the
shader reads that `images` does not list, a uniform the shader does not declare or of the wrong size. Each reason is sent once.
Each change of a prop draws once; nothing draws between changes, so a timer or spring in Contract (`task … every(frame, step)`) sets the pace.

## The language

The subset of Skia's SkSL that React Native Skia runtime effects use, so a `Skia.RuntimeEffect.Make` source runs as written.

```text
uniform shader name;                 an image: name.eval(p) is its colour at point p of the box (bilinear, premultiplied)
uniform float|float2|float3|float4 name;      half and half2..half4 likewise; one name to a line
half4 main(float2 p)                 the colour of the pixel whose centre is p; premultiplied; y down
```

`p` and every image lookup are in the box's points, so a shader draws the same on a 2x and a 3x screen. Everything else is GLSL's and Metal's
common core: functions, `for`, `pow`, `mix`, `normalize`, `exp`, `?:`. `half` is `float`. There is no integer or bool uniform.
Web translates to GLSL ES 3.00 (`web/sksl.js`), Apple to MSL (`apple/ShaderSkSL.swift`), compiled at run time on the device, so an over-the-air shader needs no build.
Images are read as stored: no colour management, alpha premultiplied.
