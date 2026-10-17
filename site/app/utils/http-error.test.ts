import { strict as assert } from 'node:assert'
import {
  describeFailedRequest,
  describeLoadFailure,
  readStatusCode
} from './http-error.ts'

// The status decides whether a failure means "you need a token", so a missing
// one has to read as 0 rather than throw or land on a real code by accident.
assert.equal(readStatusCode({ statusCode: 401 }), 401)
assert.equal(readStatusCode({ statusCode: 500 }), 500)
assert.equal(readStatusCode({ statusCode: 0 }), 0)

// A network failure never got a status at all — this is the case that must not
// be mistaken for 401, or a stopped application would read as a token problem.
assert.equal(readStatusCode({ message: 'Failed to fetch' }), 0)

// Nor is anything that is not an HTTP status one.
for (const statusCode of ['401', null, Number.NaN, 401.5, 99, 600, -401, Infinity]) {
  assert.equal(readStatusCode({ statusCode }), 0, String(statusCode))
}

for (const notAnError of [undefined, null, '', 'boom', 0]) {
  assert.equal(readStatusCode(notAnError), 0, `${JSON.stringify(notAnError)}`)
}

// What the viewer shows of a failure. A transport message quotes the URL the
// request failed on, and a response body says whatever the endpoint chose to —
// here both quote a URL carrying user info, a token under an encoded name and a
// fragment. Neither is ever shown: the words are fixed, and the status is the
// only part of a failure that gets through.
const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'
const PASSWORD = 'hunter2'
const QUOTED_URL = `http://dev:${PASSWORD}@localhost:53371/__graph-inspector/output.json?%5F%5Finspector_token=${TOKEN}#${TOKEN}`
const NO_RESPONSE = 'Could not connect to the provided URL. Make sure your NestJS app is running and the endpoint is accessible.'

function failedRequest(statusCode?: number) {
  return {
    statusCode,
    message: `[GET] "${QUOTED_URL}": ${statusCode ?? '<no response>'}`,
    data: {
      ok: false,
      error: `Rejected ${QUOTED_URL}`,
      message: `Rejected ${QUOTED_URL}`,
      errors: [QUOTED_URL]
    }
  }
}

function assertNothingQuoted(shown: unknown) {
  const text = JSON.stringify(shown)

  for (const secret of [TOKEN, ...TOKEN.split(/[.\-_]/).filter(part => part.length > 3), PASSWORD, 'localhost']) {
    assert.ok(!text.includes(secret), `a failure showed ${secret}: ${text}`)
  }

  assert.doesNotMatch(text, /inspector(?:_|%5f)token|Rejected/i, text)
}

// A response, whatever its body quotes, is told by its status.
for (const status of [404, 500, 503]) {
  const failure = describeLoadFailure(readStatusCode(failedRequest(status)))

  assert.deepEqual(failure, {
    title: 'Failed to fetch graph data',
    description: `The endpoint answered with HTTP ${status}.`
  })
  assertNothingQuoted(failure)
}

// No response at all, and anything malformed, are told the same way.
for (const error of [
  failedRequest(),
  { ...failedRequest(), statusCode: Number.NaN },
  { ...failedRequest(), statusCode: '500' },
  'boom',
  null,
  undefined
]) {
  const failure = describeLoadFailure(readStatusCode(error))

  assert.deepEqual(failure, { title: 'Failed to fetch graph data', description: NO_RESPONSE })
  assertNothingQuoted(failure)
}

assert.equal(describeLoadFailure(Number.NaN).description, NO_RESPONSE)

// A refused token is told as one, whatever the response said beside it.
const refused = describeLoadFailure(readStatusCode(failedRequest(401)), true)

assert.equal(refused.title, 'Access token required')
assert.match(refused.description, /link printed in your application console/)
assert.deepEqual(describeLoadFailure(0, true), refused)
assertNothingQuoted(refused)

// The layout's own failures follow the same rule.
for (const [error, sentence, shown] of [
  [failedRequest(422), 'The layout could not be saved', 'The layout could not be saved (HTTP 422).'],
  [failedRequest(500), 'The layout could not be loaded', 'The layout could not be loaded (HTTP 500).'],
  [failedRequest(), 'The layout could not be saved', 'The layout could not be saved.'],
  ['boom', 'The layout could not be loaded', 'The layout could not be loaded.']
] as const) {
  const described = describeFailedRequest(sentence, readStatusCode(error))

  assert.equal(described, shown)
  assertNothingQuoted(described)
}

assert.equal(describeFailedRequest('The layout could not be saved', 1e21), 'The layout could not be saved.')

console.log('http-error.test.ts ok')
