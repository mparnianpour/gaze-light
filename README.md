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
- [ ] Milestone 3 — Claude reading, moving light, spoken narration
- [ ] Milestone 4 — polish, settings, saving and loading

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

The calibration is saved on the phone. It stays valid as long as the phone, tripod and
projector don't move and the page is fullscreen.

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
