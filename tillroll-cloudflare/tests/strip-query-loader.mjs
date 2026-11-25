// Node ESM loader: strip cache-busting ?v= query strings from browser imports,
// and bind DOM globals so tillroll/*.js can run under Node + jsdom.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';

const PRELUDE = `const document = globalThis.document;
const window = globalThis.window;
const location = globalThis.location;
const localStorage = globalThis.localStorage;
const navigator = globalThis.navigator;
const fetch = globalThis.fetch;
const Node = globalThis.Node;
const HTMLElement = globalThis.HTMLElement;
const HTMLDialogElement = globalThis.HTMLDialogElement;
const File = globalThis.File;
const Blob = globalThis.Blob;
const Worker = globalThis.Worker;
const alert = globalThis.alert;
const getComputedStyle = globalThis.getComputedStyle;
`;

function stripQuery(specifier) {
  if (/\.(?:js|mjs)(?:\?|#)/.test(specifier)) {
    return specifier.replace(/(\.(?:js|mjs))(?:\?[^#]*)?(#.*)?$/, '$1$2');
  }
  if (specifier.startsWith('file:')) {
    try {
      const u = new URL(specifier);
      if (u.search) {
        u.search = '';
        return u.href;
      }
    } catch { /* keep specifier */ }
  }
  return specifier;
}

function isTillrollBrowserSource(file) {
  const marker = `${sep}tillroll${sep}`;
  if (!file.includes(marker) || !file.endsWith('.js')) return false;
  if (file.includes(`${sep}tillroll-cloudflare${sep}`)) return false;
  if (file.includes(`${sep}tillroll${sep}tests${sep}`)) return false;
  return true;
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(stripQuery(specifier), context);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith('file:')) return result;
  let file;
  try { file = fileURLToPath(new URL(url)); } catch { return result; }
  if (!isTillrollBrowserSource(file)) return result;
  let source = result.source;
  if (source == null) source = readFileSync(file);
  if (typeof source !== 'string') source = Buffer.from(source).toString('utf8');
  return { format: 'module', source: PRELUDE + source, shortCircuit: true };
}
