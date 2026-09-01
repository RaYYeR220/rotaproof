/**
 * Lets Turbopack read the workspace packages, which import each other with TypeScript's
 * ESM-style `./thing.js` specifiers.
 *
 * TypeScript resolves `./thing.js` to `thing.ts`; Turbopack does the same, but only for
 * files inside the Next project directory. The workspace packages sit above it, so their
 * specifiers arrive unaliased and every one of them fails to resolve. Rewriting the
 * specifier as the file is read is the smallest fix that leaves the packages — which are a
 * published contract, and correct as they are — untouched.
 *
 * Only relative specifiers are rewritten, and only their extension.
 */

const RELATIVE_JS_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(['"])(\.[^'"]*)\.js\2/g;

/** @param {string} source */
module.exports = function workspaceEsmLoader(source) {
  return source.replace(RELATIVE_JS_SPECIFIER, (_match, keyword, quote, specifier) => {
    return `${keyword}${quote}${specifier}${quote}`;
  });
};
