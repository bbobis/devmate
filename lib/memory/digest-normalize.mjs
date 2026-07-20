// @ts-check

/**
 * #148: normalize content to a checkout-invariant form before hashing — strip CR
 * so an LF and a CRLF checkout of identical logical content produce identical
 * digests. Without this, a freshness digest computed on an LF checkout is
 * false-stale on every CRLF checkout of the same commit (`.gitattributes` is
 * `text=auto eol=lf`, so checkouts legitimately differ by line ending), which
 * would blank out recall for a whole line-ending cohort once digests are
 * committed (the Memory v2 epic, #150). The digest becomes a function of logical
 * content, not the checkout's line endings.
 *
 * Lives in its own module so both `discovery-facts.mjs` and `fact-writer.mjs`
 * can hash normalized content without an import cycle (`discovery-facts` already
 * imports `deriveTags` from `fact-writer`).
 * @param {string} text
 * @returns {string}
 */
export function normalizeForDigest(text) {
  return text.replace(/\r/g, '');
}
