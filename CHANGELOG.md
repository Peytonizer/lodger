# Changelog

All notable changes to lodger are recorded here. One line per meaningful change; version
headings are cut when a meaningful chunk of work lands, not on every commit.

## Unreleased

## 1.0.0 — 2026-09-05

v1 is feature-complete per `SPEC.md`'s eleven build-order stages and live at
lodger.noradz.io: two-document merge, seal-and-page-number stamping under full rotation and
CropBox handling, JPEG/PNG preparation with EXIF and colour-space normalisation, live preview,
the warnings and refusals pass, the macaron palette in light and dark, and CI deploy to GitHub
Pages. 109 tests passing, clean build, clean lint.

- The palette moves out of this repo into `strata-kit`, which lodger now carries as a submodule
  at `vendor/strata-kit` and imports. The colours are unchanged; former had a copy of them that
  had begun to drift, and there is now one canonical version instead of two.
- Removed the top navigation bar linking to the other strata sites, added and then dropped in
  the same unreleased window: it meant rebuilding and redeploying this app every time the
  family menu changed elsewhere. Only the strata hub carries the bar now; the palette import
  above is unaffected.

- The page number has its own **Number height** setting, separate from the stamp's margin, so
  the seal can go hard into the corner while the number stays up in the footer band where a
  reader looks for it. Setting the two equal restores the shared optical baseline they had
  before.
- The stamp now sits closer to the bottom-right corner: the default margin is 14pt (~5mm)
  rather than 18pt. 14pt is chosen for print — a typical office laser cannot print within about
  4–4.2mm of any edge, so much under 12pt risks the stamp being clipped off the sheet. Use 18pt
  or more if the bundle will be photocopied, since copier skew compounds.

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
