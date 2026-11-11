# The `.minivtt` project file

A project file holds a whole Mini VTT library in one file: maps, handouts, fog, painted effects, spell areas and the player screen setup. **Menu (☰) → Export project…** writes one; **Menu (☰) → Import project…** reads one.

This page explains how to create one yourself, by hand or from your own program. [`project-manifest.schema.json`](project-manifest.schema.json) defines the same format as a JSON Schema, for tools that check files.

## In short

- A `.minivtt` file is a **ZIP archive**.
- At its top is **`manifest.json`**, which lists the maps and handouts and names their files.
- The images and videos are files in the same archive.
- Only three things are required: `"format"`, `"version"`, and at least one map or handout with a `"media"` file. Everything else is optional and has a default.

## Make a project file in four steps

1. **Put your images in a folder**, for example `maps/1/media.png` and `maps/2/media.jpg`.
2. **Write `manifest.json`** in that folder. The smallest valid one:

   ```json
   {
     "format": "mini-vtt-project",
     "version": 2,
     "maps": [{ "name": "Crypt", "media": "maps/1/media.png" }]
   }
   ```

3. **Zip what is in the folder**, not the folder itself: `manifest.json` must be at the top of the ZIP.
4. **Rename the `.zip` to `.minivtt`** and open it with **Menu (☰) → Import project…**.

Mini VTT measures each image, makes the thumbnails, and starts every map fully fogged.

### With a script

This Python script (standard library only) makes a project from image files:

```python
# make_project.py: python make_project.py session.minivtt crypt.png tavern.jpg
import json
import sys
import zipfile
from pathlib import Path

output, images = sys.argv[1], [Path(name) for name in sys.argv[2:]]
manifest = {"format": "mini-vtt-project", "version": 2, "generator": "make_project.py", "maps": []}

with zipfile.ZipFile(output, "w", zipfile.ZIP_STORED) as archive:
    for number, image in enumerate(images, start=1):
        media = f"maps/{number}/media{image.suffix.lower()}"
        archive.write(image, media)
        manifest["maps"].append({"name": image.stem, "media": media})
    archive.writestr("manifest.json", json.dumps(manifest, indent=2))
```

Any ZIP library works. The order of files in the archive doesn't matter, and the files may be stored or deflated.

## A complete example

Every field Mini VTT understands, filled in. All of them are explained in [Fields](#fields).

```json
{
  "format": "mini-vtt-project",
  "version": 2,
  "generator": "My Map Tool 1.0",
  "exportedAt": 1762300800000,
  "settings": {
    "playerScreenDiagonal": 43,
    "gridSize": 1,
    "portraitRotation": 270
  },
  "maps": [
    {
      "name": "Crypt",
      "media": "maps/1/media.png",
      "thumb": "maps/1/thumb.png",
      "fog": "maps/1/fog.png",
      "effects": "maps/1/effects.png",
      "mediaType": "image",
      "width": 3000,
      "height": 2000,
      "zoom": 1.5,
      "pan": { "x": 400, "y": 250 },
      "rotation": 0,
      "mirrorHorizontal": false,
      "mirrorVertical": false,
      "grid": { "cell": 100, "offsetX": 0, "offsetY": 0, "feetPerCell": 5 },
      "circles": [
        {
          "id": "fireball",
          "x": 1250,
          "y": 850,
          "shape": "circle",
          "radiusFt": 20,
          "angle": 0,
          "widthFt": 5,
          "kind": "fire",
          "color": "#ff6a1a"
        },
        {
          "id": "breath",
          "x": 600,
          "y": 400,
          "shape": "cone",
          "radiusFt": 15,
          "angle": 90,
          "widthFt": 5,
          "kind": "poison",
          "color": "#45b649"
        }
      ]
    }
  ],
  "handouts": [
    {
      "name": "Letter from the duke",
      "media": "handouts/1/media.jpg",
      "thumb": "handouts/1/thumb.png",
      "width": 1200,
      "height": 1600,
      "rotation": 270
    }
  ]
}
```

The archive for it:

```
manifest.json
maps/1/media.png
maps/1/thumb.png
maps/1/fog.png
maps/1/effects.png
handouts/1/media.jpg
handouts/1/thumb.png
```

## Checklist

The usual mistakes:

- [ ] `manifest.json` is at the top of the ZIP, not inside a folder.
- [ ] Every path in the manifest matches a file name in the ZIP exactly: same case, `/` between folders, no leading `/`, no `..`.
- [ ] `"version"` is the number `2`, not the string `"2"`.
- [ ] Positions (`x`, `y`, `grid`) are in pixels of the original image, before any `rotation` or mirroring.
- [ ] Spell area sizes (`radiusFt`, `widthFt`) are in feet, not pixels.
- [ ] In a fog mask, opaque means hidden from the players and transparent means revealed.
- [ ] Each spell area's `id` is unique on its map.

To check a manifest, validate it against [`project-manifest.schema.json`](project-manifest.schema.json) with any JSON Schema validator that supports draft 2020-12, such as Ajv for JavaScript or `jsonschema` for Python. Then import the file into Mini VTT. If anything couldn't be used, the import message says what it left out.

## Fields

Positions and sizes use these units:

- **Map pixels**: pixels of the original image (or video frame), with x to the right and y down, before rotation or mirroring. Used by spell areas and the grid.
- **`pan`** is the exception: it is in pixels of the map as shown, after rotation.
- **Feet** for spell area sizes. The map's `grid` turns feet into pixels.
- **Degrees** for rotations and angles. Rotations turn clockwise. An angle of 0 points right, and as y grows downward, larger angles turn clockwise.

### manifest.json

| Field        | Required | Value                                                                                              |
| ------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `format`     | yes      | Always `"mini-vtt-project"`.                                                                       |
| `version`    | yes      | `2`. See [Compatibility](#compatibility) for when it changes.                                      |
| `maps`       | \*       | The maps, top of the library first.                                                                |
| `handouts`   | \*       | The handouts, top of the library first.                                                            |
| `settings`   | no       | The player screen setup, below.                                                                    |
| `generator`  | no       | Your app's name and version, like `"My Map Tool 1.0"`. Shown to users when a file can't be opened. |
| `exportedAt` | no       | When the file was written, in milliseconds since 1970 (UTC).                                       |
| `requires`   | no       | Features a reader must have. Leave it out unless you need it: see [Compatibility](#compatibility). |
| `extensions` | no       | Your own data: see [Compatibility](#compatibility).                                                |

\* At least one map or handout.

### settings

All optional. They are only taken over when the library being imported into is empty, and only the ones the file gives.

| Field                  | Default | Value                                                                                      |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `playerScreenDiagonal` | `null`  | The diagonal of the player screen, in any unit. `null` shows no grid on the player screen. |
| `gridSize`             | `1`     | One grid square on the player screen, in the same unit as the diagonal.                    |
| `portraitRotation`     | `270`   | How maps and handouts taller than wide are turned when added later: `0`, `90` or `270`.    |

### A map

| Field              | Default         | Value                                                                                        |
| ------------------ | --------------- | -------------------------------------------------------------------------------------------- |
| `media`            | required        | Path of the image or video in the archive.                                                   |
| `name`             | "Imported map"  | Shown in the library. Mini VTT keeps up to 80 characters.                                    |
| `thumb`            | made from media | Path of a PNG thumbnail.                                                                     |
| `fog`              | fully fogged    | Path of the PNG fog mask. See [Images](#images).                                             |
| `effects`          | none            | Path of the PNG with painted effects. See [Images](#images).                                 |
| `width`, `height`  | measured        | The image's size in pixels, as shown (after its EXIF orientation).                           |
| `mediaType`        | from the file   | `"image"` or `"video"`. Readers look at the file itself.                                     |
| `zoom`             | `1`             | The player view's zoom: `1` shows one map pixel per screen pixel.                            |
| `pan`              | `{"x":0,"y":0}` | The top-left corner of the player view: `{ "x": …, "y": … }`, in pixels of the map as shown. |
| `rotation`         | `0`             | `0`, `90`, `180` or `270`, clockwise.                                                        |
| `mirrorHorizontal` | `false`         | Flip left to right.                                                                          |
| `mirrorVertical`   | `false`         | Flip top to bottom.                                                                          |
| `grid`             | `null`          | The map's own grid, below. `null` until measured.                                            |
| `circles`          | none            | Spell areas, below, at most 50. (Named after the first shape, the circle.)                   |
| `rooms`            | none            | Fog rooms, below, at most 100. Only the DM sees them.                                        |

### grid

The squares drawn on the map image, in map pixels.

| Field         | Default  | Value                                                               |
| ------------- | -------- | ------------------------------------------------------------------- |
| `cell`        | required | The width of one square, 2 or more.                                 |
| `feetPerCell` | required | The feet one square stands for, usually `5`.                        |
| `offsetX`     | `0`      | The x of any vertical grid line, such as the left edge of a square. |
| `offsetY`     | `0`      | The y of any horizontal grid line.                                  |

### A spell area

| Field      | Default  | Value                                                                                                                |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`       | required | 1 to 32 of `A–Z a–z 0–9 _ -`, unique on its map.                                                                     |
| `x`, `y`   | required | In map pixels: the centre of a circle or square, or the point a cone or line starts from.                            |
| `radiusFt` | required | In feet, 1 to 500: a circle's radius, a square's side, or a cone's or line's length.                                 |
| `kind`     | required | `"fire"`, `"poison"` or `"magic"`: how it is coloured.                                                               |
| `shape`    | circle   | `"circle"`, `"square"`, `"cone"` or `"line"`.                                                                        |
| `angle`    | `0`      | Degrees: where a cone or line points, or how a square is turned.                                                     |
| `widthFt`  | `5`      | A line's width in feet, 1 to 500.                                                                                    |
| `color`    | none     | The kind's colour: fire `#ff6a1a`, poison `#45b649`, magic `#5c7cff`. Used only by readers that don't know the kind. |

### A fog room

A rectangle the DM marked out to reveal or cover in one click. It doesn't change the fog by itself, so a reader that ignores rooms shows players nothing extra.

| Field             | Default  | Value                                                                              |
| ----------------- | -------- | ---------------------------------------------------------------------------------- |
| `id`              | required | 1 to 32 of `A–Z a–z 0–9 _ -`, unique on its map.                                   |
| `x`, `y`          | required | The top-left corner, in pixels of the unrotated map.                               |
| `width`, `height` | required | In pixels of the unrotated map, more than 0.                                       |
| `name`            | none     | The DM's name for it, up to 40 characters. Without one, Mini VTT shows its number. |

### A handout

| Field             | Default            | Value                                                       |
| ----------------- | ------------------ | ----------------------------------------------------------- |
| `media`           | required           | Path of the image in the archive. Handouts can't be videos. |
| `name`            | "Imported handout" | Shown in the library.                                       |
| `thumb`           | made from media    | Path of a PNG thumbnail.                                    |
| `width`, `height` | measured           | The image's size in pixels, as shown.                       |
| `rotation`        | `0`                | `0`, `90`, `180` or `270`, clockwise.                       |

### Images

- **Media**: PNG, JPEG, GIF, WebP or BMP images, and for maps also WebM video (VP8, VP9 or AV1). Mini VTT recognises the type from the file's bytes, so the file name's extension doesn't matter.
- **Fog mask** (`fog`): a PNG, opaque where the map is hidden and transparent where it is revealed. It is stretched over the whole map, so any size works; Mini VTT writes up to 1920 pixels on the long edge.
- **Effects** (`effects`): a PNG of coloured paint on a transparent background, stretched over the whole map and shown at 55% opacity under the fog. Mini VTT writes up to 1024 pixels on the long edge.
- **Thumbnails** (`thumb`): PNGs, up to 240 pixels wide. Leave them out and Mini VTT makes its own.

### Limits

Mini VTT reads up to 10,000 maps and 10,000 handouts, a manifest of up to 16 MB, fog masks, effects and thumbnails of up to 64 MB each, and up to 100,000 files in the archive. It refuses a project that needs more disk space than is free.

## How Mini VTT reads a file

- Files are found only through the paths in the manifest. Other files in the archive are ignored.
- Mini VTT checks each file's size and CRC-32 checksum. A map or handout whose file fails either check, or isn't a supported type, is skipped.
- A file that is encrypted, or compressed in a way other than deflate, counts as missing.
- An archive with a name that points outside it (`..`, or starting with `/`) is refused.
- Importing only ever adds to the library. Every map and handout gets a new id, so importing a file twice gives two copies.

## Compatibility

Project files travel between Mini VTT versions, forks and other tools. These rules decide what happens to the parts a reader doesn't understand.

### Reading a file

1. If `format` isn't `"mini-vtt-project"`, it isn't a project file.
2. If `version` is higher than the reader knows, refuse the file and ask the user to update.
3. If `requires` names a feature the reader doesn't have, refuse the file, naming the feature and the `generator`.
4. Ignore everything else unknown: fields anywhere, files in the archive, and all of `extensions`.
5. For a known field with an unknown value, keep what can still be shown correctly, leave out what can't, and tell the user. Mini VTT:
   - leaves out a spell area of an unknown `shape`, as it can't know which squares that covers;
   - keeps a spell area of an unknown `kind`, shown as the known kind nearest to its `color` (magic without one);
   - skips a map or handout whose media isn't a supported type.
6. When in doubt, hide rather than reveal: a fog mask that can't be read means a fully fogged map.

### Writing a file, in a fork or another tool

- **Add, don't change.** A new optional field or file needs no new version, because older readers ignore it. Never change what an existing field means.
- **`version` belongs to Mini VTT.** It goes up only for a change older readers would misread. A fork shouldn't raise it; use `requires`.
- **Keep your own data under `extensions`**, in an object named after your app, so it never clashes with a field Mini VTT adds later. The manifest, maps, handouts and spell areas can each have one:

  ```json
  "extensions": { "halfmoon": { "pinned": true } }
  ```

- **A new value for an existing field** (a new shape or kind) is read as above: older readers leave out a new shape, and show a new kind in the nearest colour, so always give a new kind its `color`. If a stand-in serves players better than leaving the area out, write a shape older readers know and put the real one in `extensions`, for example a half moon written as a circle with `"extensions": { "halfmoon": { "shape": "halfmoon" } }`.
- **Keep secrets where older readers won't show them.** Older readers ignore unknown fields, so a DM-only area in `circles` marked `"hidden": true` would be shown to the players. Put anything players must not see under `extensions` or in a new top-level field.
- **Use `requires` only when a file can't be read correctly without a feature.** Readers without it refuse the whole file. Start the feature's name with your app's, like `"halfmoon:arcs"`.
- **Name your app in `generator`**, so users can tell where a file came from.

### Round trips

Mini VTT doesn't keep what it doesn't understand. Importing a fork's file and exporting it again drops unknown fields and files, `extensions`, spell areas of unknown shapes, and the original kind of recoloured spell areas.

## Version 1 (Mini VTT 1.1 and 1.2)

Mini VTT 1.1 and 1.2 wrote a different file with the same extension. Later versions still import it, but 1.1 and 1.2 can't open ZIP project files.

```
8 bytes   "MVTTPRJ1"
4 bytes   length of the manifest, uint32 little-endian
n bytes   the manifest: the same fields with "version": 1, but each file is { "offset": …, "size": … }
...       the files back to back; offsets count from the end of the manifest
```
