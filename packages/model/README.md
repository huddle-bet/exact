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
| `source` | string | The `.glb`: an app asset path (`assets/phone.glb`), read by the host's asset reader: the binary's bundle or the running over-the-air generation on Apple, the page's files on the web; an `app:/` file; or a URL. |
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

| `screenNode` | string? | A glTF node (the phone's screen). Each frame its projected place changes, the view sends `screen` (below). The node is a flat rectangle facing +z before the pose. |
| `screenWidth`, `screenHeight` | number? | The size in points of the box the app lays over it (default 420 by 912), in the node's aspect. |
| `leanTo`, `leanBy` | ModelPose?, number? | A drag: the aimed pose moved `leanBy` (0..1) of the way to `leanTo`, on a spring three times quicker while `leanBy` is above 0. The app computes the share from its gesture; the spring is the view's. |

Events: `load` runs once the model has drawn twice; `failed(reason: string)` when the model, light or a picture cannot
be read, or WebGL2 is missing; `settled` when a spring arrives; `screen(ModelScreen)` when `screenNode`'s place changed.

## A live screen

`screen` carries the CSS that lays a `screenWidth` by `screenHeight` box exactly over the node, whatever the pose, spring, tilt or sway:
`perspective` (px, for a parent as large as the model), `translate` (`"x y 0"`), `rotate` (axis and angle), `scale`, `facing` (false when the
screen turns away), and `quad` (the four corners in the view's px, top left, top right, bottom right, bottom left). The kernel has `perspective`,
`translate` with a z, `rotate` with an axis and `scale` rows but no matrix, so the placement is those rows: a box with them inside a parent
with the `perspective` is projected as the model's screen is (the tests compare the corners both ways).

```text
use ModelScreen, ModelPose from "@exact/model"

component TourPhone
  state persp = 0
  state move = "0px 0px 0px"
  state turn = "0deg"
  state size = 1
  state front = false
  action placed(s: ModelScreen)
    persp = s.perspective
    move = s.translate
    turn = s.rotate
    size = s.scale
    front = s.facing
  view
    column position="relative" width=420 height=700
      exact-model source="assets/iphone-air-native.glb" screenNode="tppzCQmnlKcHIpP" screenWidth=420 screenHeight=912 hiddenNodes=["ScreenApp"] screen=placed
      column position="absolute" left=0 top=0 width=420 height=700 perspective=persp
        column position="absolute" left=0 top=-106 width=420 height=912 overflow="hidden" border-radius=62 translate=move rotate=turn scale=size display=(front ? "flex" : "none")
          TourStage
```

The box's `top` is `(viewHeight - screenHeight) / 2`, its `left` `(viewWidth - screenWidth) / 2`: the placement is for a box centred in the parent.

## What it reads of a glTF

Triangle meshes with POSITION, NORMAL and TEXCOORD_0 (normal maps use screen-space tangents); the node tree's
transforms; metallic-roughness, normal, occlusion and emissive maps; `alphaMode` BLEND (drawn after the opaque
surfaces, far to near on the web); `KHR_materials_clearcoat`; `KHR_materials_unlit` (the picture is shown as it is,
not tone mapped). No skins, morph targets, animations, cameras, sparse accessors or texture transforms.

## Known differences

- The sheen and a picture's `textures` are drawn on the model; a live screen is a box laid over it (above).
- SceneKit's lighting and tone mapping are its own: the same lights and environment give a close look, not the same pixels
  as the web. SceneKit takes a light at `intensity * 1000 / pi` lumens (a calibration to check on a device).
- The sheen on SceneKit is a surface shader modifier; the web's is in the fragment shader.
