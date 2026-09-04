# lodger

**[lodger.noradz.io](https://lodger.noradz.io)**

Merge two PDFs and stamp every page of the result — your seal or logo in the bottom-right
corner, and a page number in bold inside a circle in the footer. Out comes one PDF.

This is the shape of an exhibit or annexure stamp. The documents that need it are court
exhibits, strata and conveyancing bundles, insurance claims and the like — exactly the
category that should never be uploaded to a free online PDF service. lodger doesn't ask you
to: everything happens in your browser.

## The privacy guarantee

- **Nothing leaves your browser.** lodger makes no network requests once the page has loaded.
  No analytics, no error reporting, no CDN. This isn't only a promise: the page ships a
  Content-Security-Policy that tells the browser to block outbound connections outright, so
  you can verify it by reading one line of the HTML, or by watching an empty Network tab.
- **Nothing is stored.** No `localStorage`, no cookies, no server. Your documents, your seal
  and your settings live only in the tab's memory. Close or reload the page and they're gone.
- **Nothing is overwritten.** Your files are read, never written. The only output is the new
  PDF you download.
- **Encrypted PDFs are refused, not cracked.** If a document is password-protected, lodger
  says so and stops. Stripping a document's protection isn't its decision to make.

## Using it

1. Pick document 1 and document 2. They're merged in that order.
2. Pick your stamp image — JPEG or PNG.
3. Set the stamp size, the margin, the number size and which number to start at.
4. Check the preview, then export.

Numbering runs continuously across both documents: page 1 of document 1 is 1, and it counts
on unbroken into document 2. Bundles get produced in parts, so if part two has to start at 43,
set the start-at field to 43.

### Images

JPEG and PNG only. If your artwork is an SVG, HEIC, EPS or AI file, re-export it as one of
those two first.

**Use PNG if your seal needs to sit on top of content.** JPEG has no transparency, so a seal
saved as JPEG carries an opaque rectangle that will cover whatever is under it in the corner.
The preview shows this honestly rather than letting you find it in the exported bundle.

lodger honours a JPEG's EXIF orientation flag, so an image scanned or photographed on a phone
lands the right way up, and re-encodes progressive and CMYK JPEGs so they embed reliably.

### Mixed page sizes

A real bundle mixes A4 portrait, A4 landscape and the occasional scanned page that's rotated
sideways. lodger reads each page's own size and rotation, so the stamp lands in the visual
bottom-right of every page rather than off the edge of the ones that differ. The preview shows
the first page of each document plus one page from every distinct size and rotation in the
bundle — those are the pages placement is most likely to get wrong, so they're the ones worth
checking.

## Running it locally

```sh
npm install
npm run dev      # dev server
npm test         # test suite
npm run build    # production build into dist/
```

## Licence

MIT. See `LICENSE`.
