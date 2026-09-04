# Changelog

All notable changes to lodger are recorded here. One line per meaningful change; version
headings are cut when a meaningful chunk of work lands, not on every commit.

## Unreleased

- The stamp now sits hard into the bottom-right corner: the default margin is 4pt rather than
  18pt. Note that this is smaller than the unprintable margin of a typical office printer
  (usually 3–5mm), so raise it past about 15pt if the bundle is going to be printed rather than
  filed electronically. The page number shares the same margin, so it moves down with the seal.

- The interface: two document pickers with drag-and-drop, a stamp image picker, the four
  settings, a live preview and the export button. Its own macaron palette in light and dark,
  with a toggle; Fraunces and DM Sans self-hosted, since the CSP forbids a font CDN.
- The document the preview rasterises is kept free of the font used only for measuring, so the
  previewed bytes carry nothing the preview doesn't use. (An earlier note here claimed pdf.js
  could not render a document with an embedded standard font under this page's CSP. That was
  wrong — it renders fine, substituting a face and logging a warning. The stalls that prompted
  the claim came from driving the page in a hidden browser tab, where `requestAnimationFrame`
  is suspended and pdf.js's render loop cannot finish.)
- Asset paths are relative, so the built site works at the repository subpath GitHub Pages
  serves before a custom domain is pointed at it, not only at the domain root.
- Preview rasterises the merged document before stamping and paints the stamp over the top,
  rather than rendering the finished bytes. Chiefly so that changing a setting repaints instead
  of re-rasterising, and secondarily so the numeral is shown in the same Helvetica-Bold the
  export uses rather than the face pdf.js substitutes when it cannot fetch font data.
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
