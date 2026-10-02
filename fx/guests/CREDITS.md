# Park guests: credits and licences

The guest figures contain no third-party assets.

- **Bodies, clothes, hair, hats and carried items** are generated in code at load time by `fx/guests/assets.js`
  (lofted low-poly tubes and boxes, written for this project). Nothing is downloaded for them; `data/guests/`
  holds no files.
- **Animation** is a procedural rig evaluated in the vertex shader (`fx/guests/assets-rig.js`), written for this
  project. No motion-capture or animation clips are used.
- **Palettes** (skin, hair, clothing, lantern and balloon colours in `assets.js`) were chosen by hand.
- No AI-generated images, no likeness of a real person or of an existing character, and nothing from the parent
  project's character pictures or videos was used.

Third-party code the guests depend on, already used by the viewer: three.js 0.186.1 (MIT licence,
https://github.com/mrdoob/three.js/blob/dev/LICENSE), loaded from cdn.jsdelivr.net through the import map in
`index.html`.

Considered and not used: the CC0 character packs by Quaternius (https://quaternius.com) and Kenney
(https://kenney.nl). Procedural figures matched the park's faceted look, needed no download budget and left no
licence questions, so no file from those packs is in the repository.
