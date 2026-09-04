# Changelog

All notable changes to lodger are recorded here. One line per meaningful change; version
headings are cut when a meaningful chunk of work lands, not on every commit.

## Unreleased

- The interface: two document pickers with drag-and-drop, a stamp image picker, the four
  settings, a live preview and the export button. Its own macaron palette in light and dark,
  with a toggle; Fraunces and DM Sans self-hosted, since the CSP forbids a font CDN.
- Preview rasterises the merged document before stamping and paints the stamp over the top,
  rather than rendering the finished bytes. The Content-Security-Policy blocks all outbound
  requests, which means pdf.js cannot fetch the standard font data it would need to draw the
  embedded Helvetica-Bold numeral. Painting it onto the canvas needs neither.
- Changing a setting repaints the stamp without re-rasterising the pages, so the number fields
  respond immediately instead of re-running pdf.js on every keystroke.
- EXIF orientation is now neutralised in the JPEG's bytes before the image is decoded.
  `createImageBitmap`'s `imageOrientation: 'none'` option is not honoured by Chromium — all
  three modes return the same already-rotated bitmap — so the rotation was being applied twice
  and a phone-scanned seal landed sideways on every page.
- Stamping, merging, image preparation and the coordinate model, with 105 tests over generated
  fixtures covering all four page rotations, a non-zero CropBox origin, and CMYK, progressive
  and EXIF-rotated JPEGs.
- Project scaffolding: specification, backlog, README, changelog, licence and `.gitignore`.
