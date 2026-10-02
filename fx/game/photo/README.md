# Photo mode (`fx/game/photo/`)

Stop, frame the park, take a picture home. Works from Tour, Explore and Walk (Wick or first person).

**Keys and buttons.** `O` enters and leaves; so do `Escape` and the Done button. Entry points: `O`, the "Take a photo"
button in the journal section "Photographs", and (widths above 640 px only) a camera button next to the eye button in
the top bar. On a 390 px phone the top bar has no room (brand plus five buttons in Walk), so it is left out there.

**What it does.**
- Borrows the camera with `game.takeCamera(fn, { name: 'photo' })` from exactly the current view; shows the clean view
  (`game.ctx.setClean(true)`) and restores the earlier clean state, camera position, orientation and fov on leaving.
  Refuses to start while another module holds the camera; leaves by itself if another module takes it.
- Framing: drag looks; two fingers or right-drag slide sideways/up/down; pinch or wheel move forward and back; WASD move,
  Q/E down/up, arrows look, Shift is faster. Kept within 25 m of the start and 0.45 m above `game.ground`.
  Lens slider (vertical field of view 20 to 75 degrees, shown as an equivalent focal length; wider if the start view was
  wider), Roll slider (+-15 degrees; tap the label to level). Crops: Free, 1:1, 4:5, 16:9 with the outside dimmed, and a
  rule-of-thirds overlay; the crop sits above the control strip.
- Focus blur: tap the picture to focus there (the depth under the tap is read in the shader), Blur slider 0..100.
- Looks: Natural, Warm lantern, Cold moon, Faded print, Black and white, plus a Vignette slider centred on the crop.
- Wick: a Pose button (only when entered as Wick) cycles Stand, Look around, Trim the lantern, Warm hands by swapping
  `platformer.animator.update` while photo mode is on.
- Saving: the shutter flashes (not with Reduce motion), the next frame is read back right after `composer.render` (via
  `Q.afterRender`), cropped to the chosen aspect at the canvas's full resolution, JPEG. On touch devices with
  `navigator.canShare({files})` it opens the share sheet, otherwise it downloads `lanternfall-YYYY-MM-DD-HHMM.jpg`.
- Time: nothing is frozen (Wick is already held with the camera; guests and particles stay alive).

**The post pass.** `pass.js` is ONE extra pass, added as the last pass of the composer only while photo mode is on and
an effect is on (aperture above zero, a look, or a vignette). The composer is rebuilt when that changes, and again on
leaving. With blur on, a small pass after the scene pass converts the scene depth to metres in its own half-float
target (the composer reuses and clears its depth textures later in the chain), and the last pass gathers (72 taps
desktop, 32 phone) scaled by a circle of confusion. The blur works in Fast too (it has the same half-float composer);
only with no HDR targets (`Q.hdr` false) it is unavailable and the Focus tab says so.

**Edits outside this folder** (all marked `game hook: photo`): `app.js` (depth texture for the legacy chain, one call to
`Q.photo.build`, one call to `Q.afterRender` after the render), `fx/post.js` (depth texture, `Q.photo.build` call).

**Events.** `photo:taken` `{ place, t }`, `photo:mode` `{ on }`.

**Saved state** (key `photo`): `{ shots: [{ img (192 px JPEG data URL), place, t, w, h, at }] (newest first, 12 kept), prefs: { aspect, thirds, look } }`.

**Hash tokens.** None.

**API** (`game.modules.photo`): `enter()`, `leave()`, `active`, `state`, `cam`, `last` (`{ blob, name, w, h, ... }`), `shots`, `cropRect()`.

**Test.** `node tools/game/photo.test.mjs [url]` (SHOTS=dir writes screenshots, ONLY=0,1,2,3 picks configurations:
desktop Cinematic, phone Cinematic, desktop HD, phone Fast). It enters from Tour, Explore, Wick and first person,
moves, rolls, zooms, bounds, crops, focus, blur, looks, takes a picture (download or share intercepted), checks the
thumbnails survive a reload, leaves and compares camera, interface and Wick, and loses the WebGL context in photo mode.
