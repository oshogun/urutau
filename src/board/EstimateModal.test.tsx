import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Estimate } from '../domain/types'
import { EstimateModal } from './EstimateModal'

const stored: Estimate = { size: 'M', confidence: 'unsure', by: 'ana', at: '2026-10-01T10:00:00Z' }

function renderModal(props: Partial<React.ComponentProps<typeof EstimateModal>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<EstimateModal issue={7} estimate={null} onSave={onSave} onClose={onClose} {...props} />)
  return { onSave, onClose }
}

function save() {
  return screen.getByRole('button', { name: 'Save' })
}

describe('EstimateModal', () => {
  it('offers every size, No idea and Remove without a range', () => {
    renderModal({ estimate: stored })
    for (const name of ['S · Small', 'M · Medium', 'L · Large', 'Sure', 'Unsure', 'No idea']) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('radio', { name: 'M · Medium' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Remove estimate' })).toBeInTheDocument()
    expect(screen.queryByText(/Agent's triage range/)).not.toBeInTheDocument()
  })

  it('starts a one-size range on its size, without No idea or Remove', async () => {
    const { onSave } = renderModal({ estimate: stored, range: 'L' })
    expect(screen.getByText("Agent's triage range: L")).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'L · Large' })).toBeChecked()
    expect(screen.queryByRole('radio', { name: 'S · Small' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'M · Medium' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'No idea' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove estimate' })).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'Sure' }))
    await user.click(save())
    expect(onSave).toHaveBeenCalledWith(7, { size: 'L', confidence: 'sure' })
  })

  it('makes the person choose a size inside a wider range', async () => {
    const { onSave } = renderModal({ range: 'S-M' })
    expect(screen.getByText("Agent's triage range: S–M")).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'S · Small' })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: 'M · Medium' })).not.toBeChecked()
    expect(screen.queryByRole('radio', { name: 'L · Large' })).not.toBeInTheDocument()
    expect(save()).toBeDisabled()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: 'S · Small' }))
    await user.click(screen.getByRole('radio', { name: 'Unsure' }))
    expect(save()).toBeEnabled()
    await user.click(save())
    expect(onSave).toHaveBeenCalledWith(7, { size: 'S', confidence: 'unsure' })
  })

  it('keeps an estimate size that lies inside the range', () => {
    renderModal({ estimate: stored, range: 'M-L' })
    expect(screen.getByRole('radio', { name: 'M · Medium' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Unsure' })).toBeChecked()
    expect(save()).toBeEnabled()
  })

  it('drops an estimate size outside the range and a No idea confidence', () => {
    renderModal({ estimate: { ...stored, size: null, confidence: 'no-idea' }, range: 'S-L' })
    expect(screen.getAllByRole('radio', { checked: true }).map((radio) => radio.getAttribute('value'))).toEqual([
      'sure',
    ])
    expect(save()).toBeDisabled()
  })
})
