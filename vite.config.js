import { execSync } from 'node:child_process';

import { defineConfig } from 'vite';

/**
 * The Content-Security-Policy is the privacy claim made enforceable: with no `connect-src`,
 * the browser refuses to make an outbound request at all, so "nothing leaves your browser"
 * is something a user can verify rather than something they have to believe.
 *
 * It is injected at build time rather than written into index.html, because in dev Vite needs
 * a websocket for hot reload and an inline module preamble, both of which this policy blocks.
 * The dev server is not the artefact anyone's documents go through; the built site is.
 *
 * - `default-src 'none'` — deny everything, then allow back only what the app actually uses.
 * - no `connect-src` at all, so it falls back to default-src: fetch, XHR, beacons and
 *   websockets are all refused. This is the line that matters.
 * - `worker-src blob:` — pdf.js starts its rendering worker from a blob URL.
 * - `img-src data: blob:` — the seal preview and the rendered page canvases.
 * - `script-src 'wasm-unsafe-eval'` — pdf.js compiles WebAssembly for image decoding.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function cspPlugin() {
  return {
    name: 'lodger-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

function commitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  // Relative asset paths, so the built site works both at the custom domain's root and at the
  // repository subpath GitHub Pages serves before a domain is pointed at it. An absolute base
  // silently 404s every asset at the subpath, which looks like a broken deploy rather than a
  // misconfigured one.
  base: './',
  plugins: [cspPlugin()],
  define: {
    'import.meta.env.VITE_COMMIT_SHA': JSON.stringify(commitSha()),
  },
  build: {
    // pdf.js is large and its worker must stay a separate file; don't inline assets into JS.
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
});
