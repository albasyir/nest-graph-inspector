import { strict as assert } from 'node:assert'
import { createNodepodDemoRunGuard } from './nodepod-demo-run-guard.ts'

// A store that has never started the demo has nothing to supersede, so the
// first run is current from the moment it claims.
const guard = createNodepodDemoRunGuard()
const first = guard.claim()
assert.equal(first(), true)

// Nothing else has to happen for it to stay current: a run is only superseded
// by something taking the pod away from it.
assert.equal(first(), true)

// This is the stop() or restart() arriving mid-startup. The run that was in
// flight must never publish its endpoint, its token or its pod after this.
guard.supersede()
assert.equal(first(), false)

// The run that replaced it is current in its turn, and the one before it stays
// retired — an older checker must not come back to life behind the newer run.
const second = guard.claim()
assert.equal(second(), true)
assert.equal(first(), false)

// Restart while a startup is already pending: the earlier run is retired even
// though it never reached a checkpoint, and only the newest claim is current.
const third = guard.claim()
guard.supersede()
const fourth = guard.claim()
assert.equal(first(), false)
assert.equal(second(), false)
assert.equal(third(), false)
assert.equal(fourth(), true)

// Two claims within the same run — the store takes one inside the startup and
// one alongside it, to decide whether a failure is still worth reporting — are
// the same run and retire together.
const alongside = guard.claim()
assert.equal(alongside(), true)
assert.equal(fourth(), true)
guard.supersede()
assert.equal(alongside(), false)
assert.equal(fourth(), false)

// Superseding without a run in flight is not an error, and does not leave a
// later claim retired.
const idle = createNodepodDemoRunGuard()
idle.supersede()
idle.supersede()
assert.equal(idle.claim()(), true)

console.log('nodepod-demo-run-guard: ok')
