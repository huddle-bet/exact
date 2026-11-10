# @exact/model

`exact-model` draws a lit glTF model (a binary `.glb`) in its box: SceneKit on iOS and macOS, WebGL2 on the web.
Linux, Windows, Android, tvOS and the terminal have no implementation: the box lays out and draws nothing there,
and no handler runs (`load` never fires). An app that must show something there draws a picture beside it.

Add the package to the app's `package.json` and name its shapes:

```text
use ModelLight, ModelTexture, ModelSheen from "@exact/model"

component Phone
  derive lights = [ModelLight(yaw=-34.7, pitch=18, intensity=0.67, kelvin=6500), ModelLight(yaw=160, pitch=-15, intensity=0.57, kelvin=5500)]
  view
    exact-model source="assets/phone.glb" environment="assets/studio.ktx" ambient=0.768 lights=lights fov=24 distance=0.503 yaw=16 pitch=-2 response=850 tilt=1 sway=2.5 load=ready
```

## Props

| Prop | Type | Meaning |
|---|---|---|
| `source` | string | The `.glb`: a bundled `assets/` path, an `app:/` path (iOS, macOS), or a URL. |
| `environment` | string? | The image-based light: a KTX 1 cubemap of R11G11B10F texels as Filament's `cmgen` writes it, with its `sh` entry (the web reads the entry; SceneKit integrates the cubemap). Absent: a plain studio. |
| `ambient` | number? | Scale of the environment's light, 1 is the file as it is. Default 0.77. |
| `lights` | ModelLight[]? | Directional lights: `yaw` and `pitch` in degrees (the direction the light travels is `[-cos p sin y, -sin p, -cos p cos y]`), `intensity` (irradiance: a white diffuse surface facing the light shows `intensity / pi`), `kelvin`. At most four. |
| `fov` | number? | Vertical field of view in degrees. Default 24. |
| `distance` | number? | Camera distance from the model's origin, in the model's units, looking at the origin along -z. Wins over `viewFill`. |
| `viewFill` | number? | Without `distance`: the share of the box's height the model's bounds take. Default 0.74. |
| `yaw`, `pitch`, `roll` | number? | The pose in degrees, applied yaw first, then pitch, then roll. |
| `modelScale`, `offsetX`, `offsetY` | number? | Scale, and the model's move in its own units. |
| `response` | number? | Absent or 0: a pose prop takes effect at once. Else the pose moves on a critically damped spring that settles in about this many ms, and `settled` runs on arrival. |
| `sway`, `swayMs` | number? | Idle sway: a swing of `sway` degrees of yaw (and 0.4 of it in pitch) with period `swayMs` (default 5200). |
| `tilt` | number? | 0 to 1: how far the model leans with the device's pitch and roll (Core Motion on iOS, `deviceorientation` on the web, where iOS Safari asks at the first touch). The lean is `-gain * (angle - base)` clamped to `tiltMaxDeg`, through a spring; `base` follows the angle by `tiltRecenter` per frame, so the pose the device is held in is the centre. |
| `tiltGain`, `tiltMaxDeg`, `tiltStiffness`, `tiltDamping`, `tiltRecenter` | number? | Defaults 0.5, 6, 70, 15, 0.02. |
| `textures` | ModelTexture[]? | `node` (a glTF node name; its children too) shows the image at `source` in place of its base colour texture. The image is mapped by the node's own UVs, v down as glTF's. |
| `hiddenNodes` | string[]? | Nodes left out. |
| `sheen`, `sheenStrength`, `sheenRest`, `sheenYaw`, `sheenPitch` | ModelSheen[]?, number? | Light bands (`at`, `width`, `peak`) drawn over the unlit nodes that show a picture: a band sits at `at + sheenRest + sheenYaw * yaw + sheenPitch * pitch`, `yaw` and `pitch` being the lean, sway and spring's lag, not the pose aimed at. At most three on SceneKit, four on the web. |

Events: `load` runs once the model has drawn twice; `failed(reason: string)` when the model, light or a picture cannot
be read, or WebGL2 is missing; `settled` when a spring arrives.

## What it reads of a glTF

Triangle meshes with POSITION, NORMAL and TEXCOORD_0 (normal maps use screen-space tangents); the node tree's
transforms; metallic-roughness, normal, occlusion and emissive maps; `alphaMode` BLEND (drawn after the opaque
surfaces, far to near on the web); `KHR_materials_clearcoat`; `KHR_materials_unlit` (the picture is shown as it is,
not tone mapped). No skins, morph targets, animations, cameras, sparse accessors or texture transforms.

## Known differences

- A bundled `source` on Apple is read from the app bundle's `assets`; a file only an over-the-air generation holds is
  not reachable from a package.
- SceneKit's lighting and tone mapping are its own: the same lights and environment give a close look, not the same pixels
  as the web. SceneKit takes a light at `intensity * 1000 / pi` lumens (a calibration to check on a device).
- The sheen on SceneKit is a surface shader modifier; the web's is in the fragment shader.
