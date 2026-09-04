/**
 * controls.js — file pickers and the settings form.
 *
 * Kept apart from main.js so the wiring reads as a sequence of steps rather than as event
 * plumbing. Nothing here knows what a PDF is; it reports what the user did and lets main.js
 * decide what that means.
 */
import { SETTING_BOUNDS, clampSettings } from '../geometry.js';

/**
 * Turn a `<label class="picker">` into a drop target as well as a file input.
 *
 * A drop zone matters more than usual here: the files are being pulled out of a folder of
 * scans, and dragging two of them in is markedly faster than two trips through a file dialog.
 *
 * @param {HTMLElement} root
 * @param {(file: File) => void} onPick
 */
export function wirePicker(root, onPick) {
  const input = root.querySelector('[data-input]');

  input.addEventListener('change', () => {
    const [file] = input.files ?? [];
    if (file) onPick(file);
  });

  const setHover = (on) => root.classList.toggle('is-hover', on);

  root.addEventListener('dragover', (event) => {
    event.preventDefault();
    setHover(true);
  });
  root.addEventListener('dragleave', () => setHover(false));
  root.addEventListener('drop', (event) => {
    event.preventDefault();
    setHover(false);
    const [file] = event.dataTransfer?.files ?? [];
    if (file) onPick(file);
  });
}

/**
 * Show what a picker is holding. `state` is 'empty', 'loaded' or 'error'; `meta` is the
 * monospaced detail line — page count, pixel size — that goes under the name.
 */
export function setPickerState(root, { state, text, meta }) {
  const value = root.querySelector('[data-value]');
  root.classList.toggle('is-loaded', state === 'loaded');
  root.classList.toggle('is-error', state === 'error');

  value.replaceChildren(document.createTextNode(text));
  if (meta) {
    const detail = document.createElement('span');
    detail.className = 'picker-meta';
    detail.textContent = ` · ${meta}`;
    value.append(detail);
  }
}

/**
 * Read the settings form.
 *
 * Always through `clampSettings`: a number input hands back an empty string while it is being
 * edited and whatever was typed when it isn't, and a NaN reaching the geometry places the
 * stamp nowhere at all rather than failing loudly.
 */
export function readSettings(form) {
  const raw = {};
  for (const key of Object.keys(SETTING_BOUNDS)) raw[key] = form[key].value;
  return clampSettings(raw);
}

/**
 * Call `onChange` when a setting changes, no more than once per `delay` milliseconds' quiet.
 *
 * Re-rasterising several pages on every keystroke of a number field is the obvious way to make
 * this feel broken, and holding the up-arrow on a spinner fires a change per repeat.
 */
export function wireSettings(form, onChange, delay = 220) {
  let timer = null;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, delay);
  };
  for (const key of Object.keys(SETTING_BOUNDS)) {
    form[key].addEventListener('input', schedule);
    form[key].addEventListener('change', schedule);
  }
}
