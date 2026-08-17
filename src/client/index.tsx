import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  AgentTeamOverlay,
  AgentTeamSettingsSection,
  TeamSidebarEntry,
  type WorkspaceChoice,
} from './components.js'

export const name = 'agent-team-client'
export const inject = ['slots', 'workspaces']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'agent-team-teams', order: 20, label: '团队' },
    TeamSidebarEntry,
  ))
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'agent-team', order: 40, label: 'Agent 团队' },
    AgentTeamSettingsSection,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'agent-team',
      order: 20,
      label: '团队',
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
