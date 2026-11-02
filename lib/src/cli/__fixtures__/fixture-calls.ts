/**
 * Every constructor, factory, lifecycle hook, and middleware registration in
 * the fixture application records itself here, so a spec can show an export
 * ran none of them while a normal boot runs them all.
 */
export const fixtureCalls: string[] = [];

export function recordFixtureCall(call: string): void {
  fixtureCalls.push(call);
}
