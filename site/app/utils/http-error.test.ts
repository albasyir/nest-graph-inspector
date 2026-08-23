import { strict as assert } from 'node:assert'
import { readResponseError, readStatusCode } from './http-error.ts'

// The inspector names the reason in its body, which is what the viewer should
// show — "access token has expired" beats "Unauthorized".
assert.equal(
  readResponseError({ data: { ok: false, reason: 'expired', error: 'Token has expired.' } }),
  'Token has expired.'
)

// Anything else falls back to nothing, so the caller can use its own message.
assert.equal(readResponseError({ data: { reason: 'expired' } }), '')
assert.equal(readResponseError({ data: { error: 42 } }), '')
assert.equal(readResponseError({ data: 'plain text' }), '')
assert.equal(readResponseError({ data: null }), '')
assert.equal(readResponseError({}), '')

for (const notAnError of [undefined, null, '', 'boom', 0]) {
  assert.equal(readResponseError(notAnError), '', `${JSON.stringify(notAnError)}`)
}

// The status decides whether a failure means "you need a token", so a missing
// one has to read as 0 rather than throw or land on a real code by accident.
assert.equal(readStatusCode({ statusCode: 401 }), 401)
assert.equal(readStatusCode({ statusCode: 500 }), 500)
assert.equal(readStatusCode({ statusCode: 0 }), 0)

// A network failure never got a status at all — this is the case that must not
// be mistaken for 401, or a stopped application would read as a token problem.
assert.equal(readStatusCode({ message: 'Failed to fetch' }), 0)
assert.equal(readStatusCode({ statusCode: '401' }), 0)
assert.equal(readStatusCode({ statusCode: null }), 0)
assert.equal(readStatusCode(null), 0)
assert.equal(readStatusCode(undefined), 0)

console.log('http-error.test.ts ok')
