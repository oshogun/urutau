import { compile } from 'sass-embedded'
import { describe, expect, it } from 'vitest'

/** The declarations of one compiled rule, keyed by property. */
function declarations(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (!match) throw new Error(`No rule for ${selector}`)
  return Object.fromEntries(
    match[1]
      .split(';')
      .map((line) => line.split(':').map((part) => part.trim()))
      .filter(([property, value]) => property && value)
      .map(([property, value]) => [property, value]),
  )
}

describe('auth.scss: the new-integration form', () => {
  // Vitest runs from the repository root, and it blanks stylesheets imported into a test, so Sass
  // reads the file itself; node_modules there holds Carbon's Sass.
  const { css } = compile('src/components/auth/auth.scss', { loadPaths: ['node_modules'], quietDeps: true })

  it('makes the Permission select wide enough for "Read and move cards", but no wider than the screen', () => {
    // At 12rem, the width shared with the other create forms, the label was cut to "Read and move ca…".
    // Now 24rem to match the text input width and fully show "Read and move cards".
    expect(declarations(css, '.integrations__create .cds--select')).toMatchObject({
      width: '24rem',
      'max-width': '100%',
    })
  })

  it('lines the fields and the button up at the top and wraps on a narrow screen', () => {
    expect(declarations(css, '.integrations__create')).toMatchObject({
      'flex-wrap': 'wrap',
      'align-items': 'flex-start',
    })
    // The button drops by the height of a field label, so it lines up with the fields.
    expect(declarations(css, '.integrations__create > .cds--btn')).toMatchObject({ 'margin-top': '1.5rem' })
  })
})
