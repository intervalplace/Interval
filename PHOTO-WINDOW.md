# The photo window · drop-in

Three files, same paths as the repo root:

  window-photo.html    the new window (self-contained; three.js from CDN)
  serve.mjs            + two lines: routes /play/photo and /photo
  site/windows.html    + one card in the doorway

Run `node serve.mjs <name>` as ever; open /play/photo on the phone.
Same localStorage key as /play and /deluxe: one citizen, three windows.
POV button: first person, behind your own eyes (body hidden;
drag to look, tap the world to go; WASD walks on desktop).
Optional real sky: /play/photo?hdri=<url-to-.hdr> (Poly Haven is CC0).

Verified before shipping: the window's canonical bytes + WebCrypto Ed25519
signature pass engine.js verifyInputSig (v0.70); the terrain mirror is
copied VERBATIM from window-3d.html and executes across full classic and
expanse grids; module syntax checked.
