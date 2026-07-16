# Naming Conventions

> Good names are self-documenting. Naming is the first thing another developer sees.

## Universal Rules 🟡 SOFT

- **Full words, not abbreviations** — `calculateAmount` beats `calcAmt`
- **Booleans prefix with `is`/`has`** — `isActive`, `hasSubscription`, `isAuthenticated`
- **No generic names** — `data`, `value`, `item`, `temp` convey nothing
- **Single natural language** — never mix English and another language
- **Functions start with a verb** — `createUser`, `fetchOrders`, `validateInput`
- **UPPER_CASE for constants** — `MAX_RETRY_LIMIT`, `DEFAULT_TIMEOUT`
- **Be consistent** — `saveUserDetails` + `fetchUserDetails` ✅ vs `saveUserDetails` + `fetchUserRow` ❌
- **No double negatives** — `isAuthenticated = false` ✅ vs `isNotAuthenticated = true` ❌

## Name Length by Scope 🟡 SOFT

| Scope | Length | Example |
|---|---|---|
| Loop counter | 1 char | `i`, `j` |
| Condition/loop variable | 1 word | `isActive`, `count` |
| Methods | 1–2 words | `calculateSum`, `fetchData` |
| Classes | 2–3 words | `UserProfileManager` |
| Global constants | 3–4 words | `DEFAULT_MAX_RETRY_LIMIT` |

## DDD Naming 🟢 MINDSET

- Use the same terms the business uses — Ubiquitous Language
- ❌ `TblUsrRec`, `processData()`, `handleStuff()`
- ✅ `CustomerAccount`, `submitOrderForFulfillment()`, `applyLoyaltyDiscount()`
