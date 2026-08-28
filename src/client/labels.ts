export const TASK_STATE_LABELS: Readonly<Record<string, string>> = {
  pending: 'Pending',
  assigned: 'Assigned',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'read-only': 'Read only',
  'workspace-write': 'Workspace write',
  'danger-full-access': 'Full access',
}

export function memberStatusLabel(status: string): string {
  const labels: Readonly<Record<string, string>> = {
    offline: 'Offline',
    starting: 'Starting',
    idle: 'Idle',
    running: 'Running',
    waiting_approval: 'Awaiting approval',
    error: 'Error',
  }
  return labels[status] ?? status
}

export function taskStatusLabel(status: string): string {
  return TASK_STATE_LABELS[status] ?? status
}
