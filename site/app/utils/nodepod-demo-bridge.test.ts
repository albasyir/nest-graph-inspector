import { strict as assert } from 'node:assert'
import {
  stripAnsi,
  toRequestBody,
  toResponseBody,
  toResponseHeaders,
  withDeadline
} from './nodepod-demo-bridge.ts'

const ESC = String.fromCharCode(27)

// The demo application colours its log, and the viewer link has to be readable
// through that colouring.
assert.equal(
  stripAnsi(`${ESC}[32m[Nest] LOG${ESC}[39m Graph Viewer is available at x`),
  '[Nest] LOG Graph Viewer is available at x'
)
assert.equal(stripAnsi('plain text'), 'plain text')

// Request bodies the viewer sends: JSON strings, and binary if it ever does.
assert.equal(toRequestBody(undefined), undefined)
assert.equal(toRequestBody(null), undefined)
assert.equal(toRequestBody('{"a":1}'), '{"a":1}')
assert.equal(toRequestBody(new URLSearchParams({ a: '1' })), 'a=1')
assert.deepEqual(toRequestBody(new Uint8Array([1, 2])), new Uint8Array([1, 2]))
assert.deepEqual(
  toRequestBody(new Uint8Array([3, 4]).buffer),
  new Uint8Array([3, 4])
)
// Anything the bridge cannot forward has to say so rather than send nothing.
assert.throws(() => toRequestBody(new Blob(['x'])), TypeError)

// Response bodies come back as the runtime's own Buffer, which is a
// Uint8Array in the browser but does not have to be.
assert.equal(toResponseBody(null), null)
assert.equal(toResponseBody(undefined), null)
assert.equal(toResponseBody('{"ok":true}'), '{"ok":true}')
const bytes = toResponseBody(new Uint8Array([104, 105]))
assert.ok(bytes instanceof Uint8Array)
assert.deepEqual(bytes, new Uint8Array([104, 105]))
assert.deepEqual(toResponseBody([104, 105]), new Uint8Array([104, 105]))
assert.deepEqual(
  toResponseBody({ 0: 104, 1: 105, length: 2 }),
  new Uint8Array([104, 105])
)

// Headers arrive as a plain object with occasional arrays, and the transfer
// headers that described the body on the way out must not survive.
const headers = toResponseHeaders({
  'content-type': 'application/json; charset=utf-8',
  'content-length': '11',
  'content-encoding': 'gzip',
  'access-control-allow-methods': ['GET', 'POST'],
  'x-empty': undefined
})
assert.equal(headers.get('content-type'), 'application/json; charset=utf-8')
assert.equal(headers.get('content-length'), null)
assert.equal(headers.get('content-encoding'), null)
assert.equal(headers.get('access-control-allow-methods'), 'GET, POST')
assert.equal(headers.get('x-empty'), null)
assert.equal([...toResponseHeaders(null).keys()].length, 0)
assert.equal([...toResponseHeaders('nonsense').keys()].length, 0)

// A bridged request resolves, times out, or is abandoned when the caller says.
const settled = await withDeadline(Promise.resolve('answer'), null, 50)
assert.equal(settled, 'answer')

await assert.rejects(
  withDeadline(new Promise(() => {}), null, 10),
  (error: Error) => error.name === 'TimeoutError'
)

const controller = new AbortController()
const aborting = withDeadline(new Promise(() => {}), controller.signal, 1000)
controller.abort()
await assert.rejects(aborting, (error: Error) => error.name === 'AbortError')

const alreadyAborted = AbortSignal.abort()
await assert.rejects(
  withDeadline(new Promise(() => {}), alreadyAborted, 1000),
  (error: Error) => error.name === 'AbortError'
)

await assert.rejects(
  withDeadline(Promise.reject(new Error('runtime said no')), null, 1000),
  /runtime said no/
)

console.log('nodepod-demo-bridge: ok')
