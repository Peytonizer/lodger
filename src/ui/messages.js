/**
 * messages.js — the warnings and refusals panel.
 *
 * Refusals are things lodger will not do; warnings are things it will do that the user should
 * know about first. Both are shown in the same place so there is one thing to read before
 * exporting, rather than notices scattered next to the control that caused them.
 */

const MARKS = { refuse: '×', warn: '!', note: 'i' };

/**
 * @param {HTMLElement} container
 * @param {{kind:'refuse'|'warn'|'note', message:string}[]} entries
 */
export function renderMessages(container, entries) {
  container.replaceChildren();
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = `message message-${entry.kind}`;

    const mark = document.createElement('span');
    mark.className = 'message-mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = MARKS[entry.kind];

    const text = document.createElement('span');
    // Assistive technology gets the word, since the mark is decorative.
    const label = document.createElement('span');
    label.className = 'visually-hidden';
    label.textContent = entry.kind === 'refuse' ? 'Problem: ' : entry.kind === 'warn' ? 'Warning: ' : 'Note: ';
    text.append(label, document.createTextNode(entry.message));

    row.append(mark, text);
    container.append(row);
  }
}

/** Warnings from the pipeline, as message entries. */
export function warningEntries(warnings) {
  return warnings.map((warning) => ({
    kind: warning.code === 'image-renormalised' || warning.code === 'mixed-geometry' ? 'note' : 'warn',
    message: warning.message,
  }));
}
