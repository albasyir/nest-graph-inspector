/**
 * A module's name cut into the words it is written in — "CustomerLoyaltyModule"
 * into "Customer", "Loyalty", "Module" — so a card too narrow for it whole can
 * break it between them, never mid-word. An acronym stays one word
 * ("NestJSCoreModule": "Nest", "JS", "Core", "Module"), digits stay with the
 * word they follow, anything else is a word of its own, and the words always
 * join back into the name.
 */
export function splitNameIntoWords(name: string): string[] {
  return name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[^A-Za-z0-9]+/g) ?? [name]
}
