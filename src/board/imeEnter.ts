import type { KeyboardEvent } from 'react'

/**
 * True for the Enter that accepts an input-method conversion (Japanese, Chinese, Korean).
 * Chrome and Edge send it with `isComposing` set and Safari with `keyCode` 229, so either
 * one marks it. It must not submit a form: the user has only finished typing a word.
 */
export function isImeEnter(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229
}
