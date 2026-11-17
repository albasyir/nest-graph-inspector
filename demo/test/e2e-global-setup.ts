import { assertDemoPortsFree } from './support/demo-process';

/**
 * Jest's global setup for `test:e2e`. Every suite of the run binds the demo's
 * fixed ports — the process suite through the demo it builds and starts, the
 * others through the demo's module booted in-process — so the run refuses,
 * once and before any of them starts, while another process listens on one of
 * them: a suite booted beside it would talk to that process instead of its own.
 */
export default async function refuseWhileDemoPortsAreTaken(): Promise<void> {
  await assertDemoPortsFree();
}
