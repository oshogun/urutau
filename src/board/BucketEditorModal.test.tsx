import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Label } from '../domain/types'
import { BucketEditorModal } from './BucketEditorModal'

const labels: Label[] = [{ name: 'bug', color: 'd73a4a', description: null }]

function renderEditor() {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(<BucketEditorModal bucket={null} labels={labels} onSave={onSave} onClose={onClose} />)
  return { onSave, onClose }
}

const imeKeys = [
  ['isComposing', { key: 'Enter', isComposing: true }],
  ['keyCode 229', { key: 'Enter', keyCode: 229 }],
] as const

describe('BucketEditorModal Enter', () => {
  it.each(imeKeys)('does not save on an IME Enter in the name (%s)', async (_name, init) => {
    const { onSave, onClose } = renderEditor()
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Name' }), 'Review')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), init)
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(imeKeys)('does not save on an IME Enter in the WIP limit (%s)', async (_name, init) => {
    const { onSave, onClose } = renderEditor()
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Name' }), 'Review')
    fireEvent.keyDown(screen.getByRole('spinbutton'), init)
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it.each(imeKeys)('does not save on an IME Enter in the label filter (%s)', async (_name, init) => {
    const { onSave, onClose } = renderEditor()
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Name' }), 'Review')
    fireEvent.keyDown(screen.getByPlaceholderText('Choose labels'), init)
    expect(onSave).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('saves on a plain Enter in the name', async () => {
    const { onSave } = renderEditor()
    await userEvent.setup().type(screen.getByRole('textbox', { name: 'Name' }), 'Review{Enter}')
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toMatchObject({ title: 'Review' })
  })
})
