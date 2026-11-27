// SPDX-License-Identifier: GPL-3.0-or-later

// Text of the image extension (namespace "galatsa.image"). Keys ending in
// ".step" name the undo step a command makes, as in "Angre nytt bilde".

export default {
  name: "Bilde",
  insert: "Sett inn bilde",
  "insert.step": "nytt bilde",
  "set-style": "Endre bilde",
  "set-style.step": "endring av bilde",
  opacity: "Dekkevne",
  crop: "Beskjær bildet",
  "crop.step": "beskjæring",
  "crop-reset": "Vis hele bildet",
  "crop-reset.step": "visning av hele bildet",
  "crop-tool": "Beskjær",
  missing: "Bildet mangler",
  files: "Bildefiler",
  "file-type.png": "PNG-bilde",
  "file-type.jpeg": "JPEG-bilde",
  "file-type.webp": "WebP-bilde",
  "file-type.svg": "SVG-bilde",
  "notice.size-unknown":
    "Størrelsen på {name} kunne ikke leses, så bildet ble satt inn som et kvadrat.",
  "notice.not-image": "{name} er ikke et bilde programmet kan lese.",
};
