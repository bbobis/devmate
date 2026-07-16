# Error Handling Rules

> All rules below are 🔴 HARD unless noted otherwise.

## Never Swallow Exceptions 🔴 HARD

```js
// ❌ Error gone forever — silent production failure
try { saveUser(user) } catch (e) {}

// ✅ Log, propagate, or handle meaningfully
try {
  saveUser(user)
} catch (error) {
  logger.error('Failed to save user', { userId: user.id, error })
  throw error
}
```

## Never Over-Catch 🔴 HARD

```js
// ❌ Catches everything, handles nothing specific
try { connect() } catch (e) { log('something went wrong') }

// ✅ Catch the specific error you can actually handle
try {
  connect()
} catch (ConnectionTimeoutError e) {
  retryWithBackoff()
} catch (AuthenticationError e) {
  alertOps('DB credentials invalid')
  throw e
}
```

## Never Use Exceptions as Flow Control 🔴 HARD

```js
// ❌ "Not found" is expected — not an exception
try {
  let user = findUser(id)
} catch (UserNotFoundException e) {
  createUser(id)
}

// ✅ Regular conditional for expected conditions
let user = findUser(id)
if (user === null) createUser(id)
```

## Always Preserve the Error Chain 🔴 HARD

```js
// ❌ Root cause is destroyed
try { parseConfig(file) } catch (e) { throw new Error('Config failed') }

// ✅ Preserve the cause
try { parseConfig(file) } catch (e) { throw new ConfigError('Config failed', { cause: e }) }
```

## Fail Fast at Boundaries 🔴 HARD

```js
// ✅ Validate at every trust boundary before touching state
function processOrder(order) {
  if (!order) throw new Error('order must not be null')
  if (order.quantity <= 0) throw new Error('quantity must be positive')
  if (order.price < 0) throw new Error('price must not be negative')
  db.save({ orderId: order.id, total: order.quantity * order.price })
}
```

| Layer | Validate | Fail Behavior |
|---|---|---|
| API/Controller | Input shape, required fields, types | Return 400 with clear message |
| Service/Domain | Business rules, invariants | Throw domain exception |
| Repository/DB | Constraint violations | Wrap and rethrow with context |
| External calls | Response structure, status codes | Retry or circuit breaker |
