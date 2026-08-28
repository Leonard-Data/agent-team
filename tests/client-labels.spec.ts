import { describe, expect, it } from 'vitest'
import { PERMISSION_LABELS, TASK_STATE_LABELS, taskStatusLabel } from '../src/client/labels.js'

describe('taskStatusLabel', () => {
  it.each([
    ['pending', 'Pending'],
    ['assigned', 'Assigned'],
    ['in_progress', 'In progress'],
    ['completed', 'Completed'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ])('maps %s to its English label', (status, label) => {
    expect(taskStatusLabel(status)).toBe(label)
  })

  it.each(['paused', 'unknown_state', ''])('returns an unknown status %j as-is', status => {
    expect(taskStatusLabel(status)).toBe(status)
  })

  it('keeps TASK_STATE_LABELS intact', () => {
    expect(TASK_STATE_LABELS).toEqual({
      pending: 'Pending',
      assigned: 'Assigned',
      in_progress: 'In progress',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    })
  })

  it('keeps PERMISSION_LABELS intact', () => {
    expect(PERMISSION_LABELS).toEqual({
      'read-only': 'Read only',
      'workspace-write': 'Workspace write',
      'danger-full-access': 'Full access',
    })
  })
})
