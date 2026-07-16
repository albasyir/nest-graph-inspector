/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { strict as assert } from 'node:assert'
import { requiresVersionAcknowledgement } from './graph-inspector-version-gate.ts'

assert.equal(requiresVersionAcknowledgement(true, false), false)
assert.equal(requiresVersionAcknowledgement(false, false), true)
assert.equal(requiresVersionAcknowledgement(undefined, false), true)
assert.equal(requiresVersionAcknowledgement('true', false), true)
assert.equal(requiresVersionAcknowledgement(false, true), false)

console.log('graph-inspector-version-gate.test.ts ok')
