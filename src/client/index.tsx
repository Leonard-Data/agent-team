import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  AgentTeamOverlay,
  AgentTeamSettingsSection,
  type WorkspaceChoice,
} from './components.js'

export const name = 'agent-team-client'
export const inject = ['slots', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'agent-team', order: 40, label: 'Agent Team' },
    AgentTeamSettingsSection,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'agent-team',
      order: 20,
      label: 'Team',
      inject: (): { pickWorkspace: () => Promise<WorkspaceChoice | null> } => ({
        pickWorkspace: async () => {
          const path = await ctx.workspaces.pickDirectory()
          if (path === null) return null
          const workspace = await ctx.workspaces.create({ path })
          return {
            id: workspace.workspaceId,
            path: workspace.path,
            title: workspace.title,
          }
        },
      }),
    },
    AgentTeamOverlay,
  ))
}
