# Gaze Light

A projection piece for paintings. An Android phone on a tripod watches the
paintings through its rear camera; its screen is cast to a projector over
Miracast (Smart View). Claude decides where to look, a soft brush-painted
light wanders across the paintings like a gaze, and the phone speaks what it
is looking at and why.

Runs in Chrome on the phone as a web page — no app store. It is hosted on
GitHub Pages so Chrome gets HTTPS (needed for the camera).

## Status

- [x] **Milestone 1** — camera, black fullscreen output, calibration with visible confirmation
- [x] **Milestone 2** — tap painting corners, flatten and save them, soft-brush test light
- [x] **Milestone 3** — readings played on the wall: moving light and spoken narration (readings written ahead of time; no API needed)
- [x] **Segments, step 1** — the painting's own segments filled with coloured light, compositions crossfading
- [ ] Segments, step 2 — edit segments (merge, split, draw) and design compositions by hand
- [ ] Milestone 4 — polish, colour correction, saving and loading

## Using milestone 1

1. Phone on the tripod in landscape, rear camera facing the wall. Start Smart View to the projector.
2. Open the page in Chrome and tap **Start**. Allow the camera. The page goes fullscreen.
3. Dim the room. Tap **Calibrate**, step out of the camera's view. The projector flashes
   one dot at a time (about 20–30 seconds). Tap the screen to cancel.
4. The result card says ✓ or ✗, with how many dots were seen and the error in phone-screen pixels.
   The dashed outline shows where the projector reaches in the camera view; green rings are dots used,
   red rings dots ignored, grey crosses dots the camera could not see.
5. Check it: tap any spot in the camera view. The screen goes dark and a cross is projected
   onto that spot on the wall.

The menu is behind the **top-right corner** (☰ in the camera view, invisible on the black screen).

## Using milestone 2

1. **Paintings** (button in the camera view): tap the 4 corners of a painting, in any order.
   Press on a corner and drag to adjust it; a magnifier shows what is under your finger.
   Tap 4 more corners for the next painting. Tap inside a painting to select it (to delete it).
2. **Capture images**: the projector goes black (or warm white, see the menu), the camera
   takes one frame and each painting is flattened. The review shows what Claude will look at;
   rename the paintings there.
3. **Test light**: tap a spot in the camera view (or press and drag to set its size).
   The screen goes dark and the soft light blooms on that spot on the wall.
   While it's lit, tap the dark screen anywhere to move the light there (old spot fades,
   new one blooms); double-tap to go back.
4. Light settings in the menu: brightness, size, softness, falloff distance, transition, colour.

Paintings, corners and images are saved on the phone and survive a reload.

## Segments (colour compositions)

"Segments over segments": the painting is cut into segments that follow its own shapes and
colour areas, and compositions fill some of them with coloured light while the rest of the
painting gets soft neutral light. One composition crossfades into the next.

1. Calibrate, mark the painting's corners and **Capture images** (or, in the menu's painting
   list, **Use my photo**: a photo cropped exactly to the canvas edges).
2. Menu → Paintings → **Find segments** (also done automatically the first time).
   **Show segments** projects the outlines onto the painting so you can check the fit; tap to close.
3. Menu → Performance → *What to perform: Segments* → **Perform**.
4. While it plays: **♥ Save this composition** keeps the one on the wall; *Compositions*
   chooses new, saved, or both. Hold time, crossfade, colour coverage, light on the rest of
   the painting and colour brightness are adjustable.

## Using milestone 3 (gaze)

1. Calibrate and mark the painting's corners (milestones 1 and 2).
2. Menu → **Performance → Readings**: each painting named in the readings is linked to
   a painting you marked on the phone (automatic when there is one of each).
3. Tap **Perform**. The screen goes black; the light moves from stop to stop and the
   phone speaks each stop as the light arrives. Nothing is written on the wall.
   Readings play in shuffled order with a dark pause between them.
4. Menu: pause / resume, next stop, next reading, stop; movement (dissolve, glide, or
   glide near and dissolve far); length of the dark pause; voice, speed and pitch.

The camera is switched off during the performance to save battery. Readings are cached on
the phone, so a performance can start even if the network drops.

The calibration is saved on the phone. It stays valid as long as the phone, tripod and
projector don't move and the page is fullscreen.

## Readings

A reading is a journey of 8–12 stops across the paintings. Each stop has a region
(centre `x`, `y` and size `w`, `h` as fractions of the painting, measured from the canvas
edges, plus an `angle`), a minimum `dwell` in seconds, and one or two sentences to speak.

Readings written ahead of time live in [`readings/`](readings/), one file per painting.
`readings/yellow.json` holds 7 readings of the yellow painting, each moving through the
artist's three movements: *the wind comes, it's taking root, tension comes*.
The milestone 3 player plays them on the wall; no API key is needed for these.

## Privacy and keys

Nothing is sent anywhere in milestone 1. From milestone 3 the app calls the Claude API
directly from the phone with an API key you enter in the app's settings; the key is
stored only in the phone's browser storage and is never part of this repository.

## Local testing

```
node tools/serve.mjs
```

Then open `http://localhost:8080/?sim`. `?sim` replaces the camera with a simulated wall
and projector, so calibration can be tested on a computer.
