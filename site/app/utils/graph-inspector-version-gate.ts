export function requiresVersionAcknowledgement(
  isLatestVersion: unknown,
  isStatic: unknown
) {
  return isStatic !== true && isLatestVersion !== true
}
