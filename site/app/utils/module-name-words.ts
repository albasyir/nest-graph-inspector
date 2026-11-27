/**
 * A module's name cut into the words it is written in — "CustomerLoyaltyModule"
 * into "Customer", "Loyalty", "Module" — so a card too narrow for it whole can
 * break it between them, never mid-word.
 *
 * - An acronym stays one word: "NestJSCoreModule" is "Nest", "JS", "Core",
 *   "Module".
 * - Digits stay with the word or acronym they follow: "Auth2Module" is
 *   "Auth2", "Module", and "HTTP2Module" is "HTTP2", "Module".
 * - A capital standing alone before a capitalised word is a word of its own:
 *   "OAuth2Module" is "O", "Auth2", "Module".
 * - Anything else is a word of its own.
 *
 * The words always join back into the name.
 */
export function splitNameIntoWords(name: string): string[] {
  return name.match(/[A-Z]+[0-9]*(?![a-z])|[A-Z]?[a-z0-9]+|[^A-Za-z0-9]+/g) ?? [name]
}
