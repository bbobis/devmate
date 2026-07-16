// @ts-check
// Prototype-safe object helpers.
//
// `table[key]` with a data-derived key consults the prototype chain, so a key
// like "constructor" or "__proto__" returns a function instead of undefined.
// `getOwn` looks up own properties only, which is both the actual intent of
// every lookup-table access in this codebase and the fix pattern that
// secure-coding/detect-object-injection recognizes.

/**
 * Own-property lookup: returns `table[key]` when `key` is an own property of
 * `table`, otherwise `undefined`. Never consults the prototype chain.
 *
 * @template {object} T
 * @param {T} table
 * @param {PropertyKey} key
 * @returns {T[keyof T] | undefined}
 */
export function getOwn(table, key) {
  if (Object.hasOwn(table, key)) {
    return table[/** @type {keyof T} */ (key)];
  }
  return undefined;
}

/**
 * True when `value` is a plain (non-null, non-array) object.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when `value` is a string (possibly empty).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isString(value) {
  return typeof value === "string";
}

/**
 * True when `value` is a string with non-whitespace content.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
