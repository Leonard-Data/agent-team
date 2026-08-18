import { useCallback, useEffect, useState } from 'react'
import {
  Button, IconAgentPresetOutline16, IconCloseOutline16, IconPlusOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { AssistantPanel } from './assistants/AssistantPanel.js'
import {
  callAgentTeam,
  subscribeAgentTeam,
} from './api.js'
import { closeAgentTeam, openTeam, openTeamCreator, openTeams, useAgentTeamUi } from './store.js'
import { isTeamExecuting } from './team-status.js'
import { TeamPanel } from './teams/TeamPanel.js'
import type { WorkspaceChoice } from './types.js'
import css from './AgentTeam.module.css'
import type {
  AssistantView,
  CatalogView,
  TeamView,
} from '../transport/contracts.js'

export type { WorkspaceChoice } from './types.js'
export function TeamSidebarEntry({ wide }: { wide: boolean }): JSX.Element {
  const [teams, setTeams] = useState<TeamView[]>([])

  const load = useCallback(async () => {
    try {
      const page = await callAgentTeam('team.list')
      setTeams(page.items)
    } catch {
      // The full team surface owns error presentation; a sidebar refresh failure
      // keeps the last good projection instead of replacing navigation with noise.
    }
  }, [])

  useEffect(() => {
    void load()
    return subscribeAgentTeam(() => { void load() }, () => {})
  }, [load])

  return (
    <section className={`${css.sidebarTeams} ${wide ? '' : css.sidebarTeamsRail}`} aria-label="团队">
      <div className={css.sidebarTeamHeader}>
        <Tooltip label="团队" delayMs={500} disabled={wide}>
          <button
            type="button"
            className={css.sidebarTeamMain}
            onClick={openTeams}
            aria-label="打开团队工作台"
          >
            <IconAgentPresetOutline16 size={wide ? 16 : 18} />
            {wide && <span className={css.sidebarTeamLabel}>团队</span>}
          </button>
        </Tooltip>
        {wide && (
          <Tooltip label="组建团队" delayMs={500}>
            <button type="button" className={css.sidebarTeamAdd} onClick={openTeamCreator} aria-label="组建团队">
              <IconPlusOutline16 size={16} />
            </button>
          </Tooltip>
        )}
      </div>
      {wide && teams.length > 0 && (
        <div className={css.sidebarTeamList}>
          {teams.map(team => {
            const executing = isTeamExecuting(team)
            return (
              <button
                key={team.id}
                type="button"
                className={css.sidebarTeamItem}
                onClick={() => { openTeam(team.id) }}
                title={`${team.name} · ${team.workspacePath}`}
              >
                <span className={css.sidebarTeamBranch} aria-hidden="true" />
                <span className={css.sidebarTeamName}>{team.name}</span>
                {executing && <span className={css.sidebarTeamState}>任务执行中</span>}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function useAgentTeamData(includeTeams: boolean, active = true): {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  loading: boolean
  error: string | undefined
  load: () => Promise<void>
} {
  const [catalog, setCatalog] = useState<CatalogView>()
  const [assistants, setAssistants] = useState<AssistantView[]>([])
  const [teams, setTeams] = useState<TeamView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      void callAgentTeam('catalog.get')
        .then(value => { setCatalog(value) })
        .catch(cause => {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(current => current === undefined ? message : `${current}；${message}`)
        })
      const coreRequests = [
        callAgentTeam('assistant.list').then(value => { setAssistants(value.items) }),
        includeTeams
          ? callAgentTeam('team.list').then(value => { setTeams(value.items) })
          : Promise.resolve().then(() => { setTeams([]) }),
      ]
      const results = await Promise.allSettled(coreRequests)
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason instanceof Error ? result.reason.message : String(result.reason))
      if (failures.length > 0) setError(failures.join('；'))
    } finally {
      setLoading(false)
    }
  }, [includeTeams])

  useEffect(() => {
    if (!active) return
    void load()
    return subscribeAgentTeam(() => { void load() }, () => { setError('事件连接已断开，正在等待重连') })
  }, [active, load])

  return { catalog, assistants, teams, loading, error, load }
}

export function AgentTeamSettingsSection(_props: SettingsSectionOwnerProps): JSX.Element {
  const { catalog, assistants, loading, error, load } = useAgentTeamData(false)
  return (
    <section className={css.settingsSection}>
      <div className={css.settingsHeading}>
        <div>
          <h1 className={css.settingsTitle}>Agent 团队</h1>
          <p className={css.settingsDescription}>管理可在不同团队间复用的助手、模型和权限配置。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { void load() }} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>
      {error && <div role="alert" className={css.error}>{error}</div>}
      <AssistantPanel catalog={catalog} assistants={assistants} onChanged={load} />
    </section>
  )
}

export function AgentTeamOverlay({ pickWorkspace }: { pickWorkspace: () => Promise<WorkspaceChoice | null> }): JSX.Element | null {
  const { visible, createTeamRequest, selectedTeamId } = useAgentTeamUi()
  const { catalog, assistants, teams, error, load } = useAgentTeamData(true, visible)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)

  if (!visible) return null

  return (
    <section className={css.fullscreenWorkbench} aria-label="Agent 团队工作台">
      <aside className={css.teamNavigator} aria-label="团队列表">
        <div className={css.teamNavigatorHeader}>
          <button
            type="button"
            className={css.teamNavigatorTitle}
            onClick={openTeams}
            aria-label="查看全部团队"
            aria-current={selectedTeamId === undefined ? 'page' : undefined}
          >
            <IconAgentPresetOutline16 size={18} />
            <span>团队</span>
          </button>
          <Tooltip label="组建团队" delayMs={400}>
            <button type="button" className={css.teamNavigatorAdd} onClick={openTeamCreator} aria-label="组建团队">
              <IconPlusOutline16 size={16} />
            </button>
          </Tooltip>
        </div>
        <div className={css.teamNavigatorList}>
          {teams.length === 0
            ? <div className={css.teamNavigatorEmpty}>还没有团队</div>
            : teams.map(team => {
              const isSelected = team.id === selectedTeamId
              const executing = isTeamExecuting(team)
              return (
                <button
                  key={team.id}
                  type="button"
                  className={`${css.teamNavigatorItem} ${isSelected ? css.teamNavigatorItemActive : ''}`}
                  onClick={() => { openTeam(team.id) }}
                  aria-current={isSelected ? 'page' : undefined}
                >
                  <span className={css.teamNavigatorItemTop}>
                    <strong>{team.name}</strong>
                    {executing && <span className={`${css.badge} ${css.badgeSuccess}`}>任务执行中</span>}
                  </span>
                </button>
              )
            })}
        </div>
        <div className={css.teamNavigatorFooter}>
          <span>{teams.length} 个团队</span>
        </div>
      </aside>

      <div className={css.fullscreenWorkbenchMain}>
        <header className={css.shellHeader}>
          <div className={css.headerCopy}>
            <div className={css.shellTitleRow}>
              <h1 className={css.title}>{selectedTeam?.name ?? 'Agent 团队'}</h1>
              {selectedTeam !== undefined && isTeamExecuting(selectedTeam) && (
                <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>
                  任务执行中
                </span>
              )}
            </div>
            <p className={css.subtitle}>
              {selectedTeam === undefined
                ? '多个平级 Agent，共享一个 Workspace'
                : `${Object.keys(selectedTeam.members).length} 名成员 · ${selectedTeam.workspacePath}`}
            </p>
          </div>
          <button type="button" className={css.iconButton} onClick={closeAgentTeam} aria-label="关闭工作台">
            <IconCloseOutline16 size={16} />
          </button>
        </header>
        {error && <div role="alert" className={css.error}>{error}</div>}
        <main className={`${css.content} ${selectedTeam === undefined ? '' : css.workbenchContent ?? ''}`}>
          <TeamPanel
            catalog={catalog}
            assistants={assistants}
            teams={teams}
            createRequest={createTeamRequest}
            selectedTeamId={selectedTeamId}
            pickWorkspace={pickWorkspace}
            onChanged={load}
          />
        </main>
      </div>
    </section>
  )
}
