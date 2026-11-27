// SPDX-License-Identifier: GPL-3.0-or-later

// Text of the image extension (namespace "galatsa.image"). Keys ending in
// ".step" name the undo step a command makes, as in "Undo new image".

export default {
  name: "Image",
  insert: "Insert image",
  "insert.step": "new image",
  "set-style": "Change image",
  "set-style.step": "image change",
  opacity: "Opacity",
  crop: "Crop image",
  "crop.step": "cropping",
  "crop-reset": "Show the whole image",
  "crop-reset.step": "showing the whole image",
  "crop-tool": "Crop",
  missing: "Image missing",
  files: "Image files",
  "file-type.png": "PNG image",
  "file-type.jpeg": "JPEG image",
  "file-type.webp": "WebP image",
  "file-type.svg": "SVG image",
  "notice.size-unknown": "{name} could not be read as an image, so it was not inserted.",
  "notice.not-image": "{name} is not an image this program can read.",
};
