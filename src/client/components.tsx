import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button, IconAgentPresetOutline16, IconArchiveOutline20, IconCloseOutline16, IconFolderOpenOutline16, IconPlusOutline16,
  IconPaperclipOutline16, IconRefreshOutline16, IconSendOutline16, IconStopFill16, MarkdownText, MessageText, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  callAgentTeam,
  subscribeAgentTeam,
  subscribeAgentTeamConversation,
  subscribeAssistantBuilderConversation,
  uploadAgentTeamFile,
} from './api.js'
import { closeAgentTeam, openTeam, openTeamCreator, openTeams, useAgentTeamUi } from './store.js'
import { mergeConversationNodes } from './conversation-nodes.js'
import { insertWorkspaceFileMention } from './file-mentions.js'
import { shouldSubmitComposer } from './keyboard.js'
import { CrownIcon } from './icons/CrownIcon.js'
import {
  initialVisibleMemberSlots,
  reconcileVisibleMemberSlots,
  toggleVisibleMemberSlot,
} from './member-visibility.js'
import { isTeamExecuting } from './team-status.js'
import css from './AgentTeam.module.css'
import type {
  ConversationNode,
  AssistantBuilderConversationListView,
  AssistantBuilderConversationSummary,
  AssistantBuilderConversationView,
  AssistantBuilderDraftView,
  MemberConversationView,
  TeamWorkbenchView,
  WorkspaceEntryView,
  WorkspaceUploadView,
} from '../transport/contracts.js'

interface AssistantView {
  id: string
  name: string
  description?: string
  instructions: string
  provider: string
  model: string
  agentPresetId: string
  permissionPresetId: string
  skillAllowlist: string[]
  mcpServers: string[]
  revision: number
}

interface TeamView {
  id: string
  name: string
  state: string
  workspacePath: string
  leaderSlotId: string
  members: Record<string, {
    id: string
    assistantId: string
    displayName: string
    role: 'leader' | 'member'
    sessionId: string
    lastRuntimeState: string
    permissionPresetId: string
    assistantSnapshot: { provider: string; model: string; permissionPresetId: string }
  }>
  directMemberChat: boolean
  tasks: Record<string, {
    id: string
    title: string
    description: string
    status: string
    ownerSlotId?: string
    fileScopes: string[]
    result?: string
    error?: string
  }>
  revision: number
}

interface CatalogView {
  providers: Array<{ id: string; name: string }>
  models: Record<string, Array<{ id: string; name: string; description?: string }>>
  agentPresets: Array<{ id: string; name: string; description?: string; broken?: string }>
  permissionPresets: Array<{ value: string; name: string; description?: string }>
  workspaces: Array<{ id: string; path: string; title: string; status: 'ok' | 'missing-dir' }>
}

interface SkillCatalogView {
  agentPresetId: string
  skills: Array<{
    name: string
    description: string
    source: string
  }>
}

interface McpCatalogView {
  agentPresetId: string
  servers: Array<{
    name: string
    tools: Array<{
      name: string
      description: string
    }>
  }>
}

export interface WorkspaceChoice {
  id: string
  path: string
  title: string
}

interface Page<T> {
  items: T[]
  total: number
}

const TASK_STATE_LABELS: Record<string, string> = {
  pending: '待处理',
  assigned: '已分配',
  in_progress: '进行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const ASSISTANT_FORM_ID = 'agent-team-assistant-form'
const ASSISTANT_EDIT_FORM_ID = 'agent-team-assistant-edit-form'

const PERMISSION_LABELS: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
}

export function TeamSidebarEntry({ wide }: { wide: boolean }): JSX.Element {
  const [teams, setTeams] = useState<TeamView[]>([])

  const load = useCallback(async () => {
    try {
      const page = await callAgentTeam<Page<TeamView>>('team.list')
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
          <div className={css.sidebarTeamMain}>
            <IconAgentPresetOutline16 size={wide ? 16 : 18} />
            {wide && <span className={css.sidebarTeamLabel}>团队</span>}
          </div>
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
      void callAgentTeam<CatalogView>('catalog.get')
        .then(value => { setCatalog(value) })
        .catch(cause => {
          const message = cause instanceof Error ? cause.message : String(cause)
          setError(current => current === undefined ? message : `${current}；${message}`)
        })
      const coreRequests = [
        callAgentTeam<Page<AssistantView>>('assistant.list').then(value => { setAssistants(value.items) }),
        includeTeams
          ? callAgentTeam<Page<TeamView>>('team.list').then(value => { setTeams(value.items) })
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
              const tasks = Object.values(team.tasks)
              const completed = tasks.filter(task => task.status === 'completed').length
              const active = tasks.filter(task => task.status === 'assigned' || task.status === 'in_progress' || task.status === 'running').length
              const progress = tasks.length === 0 ? 0 : Math.round(completed / tasks.length * 100)
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
                    {executing && <span className={`${css.teamNavigatorStateDot} ${css.teamNavigatorStateActive}`} aria-hidden="true" />}
                  </span>
                  <span className={css.teamNavigatorMeta}>
                    {executing && <span>任务执行中</span>}
                    <span>{tasks.length === 0 ? '暂无任务' : `任务 ${completed}/${tasks.length}${active > 0 ? ` · 进行中 ${active}` : ''}`}</span>
                  </span>
                  {tasks.length > 0 && (
                    <span className={css.teamNavigatorProgress} aria-label={`任务完成度 ${progress}%`}>
                      <span style={{ width: `${progress}%` }} />
                    </span>
                  )}
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

function AssistantPanel({
  catalog,
  assistants,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const [editingAssistant, setEditingAssistant] = useState<AssistantView>()
  const [builderOpen, setBuilderOpen] = useState(false)
  const [assistantSaving, setAssistantSaving] = useState(false)
  return (
    <section className={css.section}>
      <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>助手模板 <span className={css.count}>{assistants.length}</span></h2>
          <p className={css.sectionDescription}>助手是可复用模板，解散团队不会删除助手。</p>
        </div>
        <div className={css.actions}>
          <Button variant="primary" onClick={() => { setCreating(true) }}>手动新建</Button>
        </div>
      </div>
      <article className={css.assistantBuilderCard}>
        <div className={css.assistantBuilderAvatar} aria-hidden="true">AI</div>
        <div className={css.assistantBuilderCopy}>
          <span className={css.assistantBuilderEyebrow}>内置 · 默认</span>
          <strong>团队 Agent 小助手</strong>
          <p>描述你需要的角色，它会询问必要参数、整理长期提示词，并在确认后创建助手。</p>
        </div>
        <Button variant="primary" onClick={() => { setBuilderOpen(true) }}>开始对话</Button>
      </article>
      {assistants.length === 0
        ? <Empty text="还没有助手模板" hint="创建助手后，就可以把它作为 Leader 或普通成员加入不同团队。" />
        : (
            <div className={css.cardGrid}>
              {assistants.map(assistant => (
                <AssistantCard
                  key={assistant.id}
                  assistant={assistant}
                  onEdit={() => { setEditingAssistant(assistant) }}
                  onChanged={onChanged}
                />
              ))}
            </div>
          )}
      <Modal
        open={builderOpen}
        onClose={() => { setBuilderOpen(false) }}
        title="团队 Agent 小助手"
        closeLabel="关闭"
        description="通过对话设计助手；完整配置会在你确认后保存到助手模板库。"
        className={css.assistantBuilderDialog ?? ''}
        contentClassName={css.assistantBuilderDialogContent ?? ''}
      >
        {builderOpen && <AssistantBuilderConversation catalog={catalog} />}
      </Modal>
      <Modal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建助手"
        closeLabel="关闭"
        description="配置可复用的模型、权限与长期规则。具体任务在团队启动后发送。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreating(false) }} disabled={assistantSaving}>取消</Button>
            <Button
              variant="primary"
              type="submit"
              form={ASSISTANT_FORM_ID}
              disabled={assistantSaving}
            >
              {assistantSaving ? '保存中…' : '保存助手'}
            </Button>
          </>
        )}
      >
        <AssistantForm
          catalog={catalog}
          formId={ASSISTANT_FORM_ID}
          saving={assistantSaving}
          setSaving={setAssistantSaving}
          onSaved={async () => { setCreating(false); await onChanged() }}
        />
      </Modal>
      <Modal
        open={editingAssistant !== undefined}
        onClose={() => { setEditingAssistant(undefined) }}
        title="编辑助手"
        closeLabel="关闭"
        description="更新助手模板只影响之后启动的团队成员，不修改已有成员快照。"
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={editingAssistant === undefined
          ? undefined
          : (
              <>
                <Button variant="outline" onClick={() => { setEditingAssistant(undefined) }} disabled={assistantSaving}>取消</Button>
                <Button
                  variant="primary"
                  type="submit"
                  form={ASSISTANT_EDIT_FORM_ID}
                  disabled={assistantSaving}
                >
                  {assistantSaving ? '保存中…' : '保存修改'}
                </Button>
              </>
            )}
      >
        {editingAssistant !== undefined && (
          <AssistantForm
            key={`${editingAssistant.id}:${editingAssistant.revision}`}
            catalog={catalog}
            formId={ASSISTANT_EDIT_FORM_ID}
            assistant={editingAssistant}
            saving={assistantSaving}
            setSaving={setAssistantSaving}
            onSaved={async () => { setEditingAssistant(undefined); await onChanged() }}
          />
        )}
      </Modal>
    </section>
  )
}

function AssistantBuilderConversation({ catalog }: { catalog: CatalogView | undefined }): JSX.Element {
  const [conversation, setConversation] = useState<AssistantBuilderConversationView>()
  const [draft, setDraft] = useState<AssistantBuilderDraftView>()
  const [history, setHistory] = useState<AssistantBuilderConversationSummary[]>([])
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [applyingModel, setApplyingModel] = useState(false)
  const [archivingSessionId, setArchivingSessionId] = useState<string>()
  const [archiveCandidate, setArchiveCandidate] = useState<AssistantBuilderConversationSummary>()
  const [archiveError, setArchiveError] = useState<string>()
  const [selectedProvider, setSelectedProvider] = useState('')
  const [selectedModel, setSelectedModel] = useState('')
  const [modelSelectionDirty, setModelSelectionDirty] = useState(false)
  const [error, setError] = useState<string>()
  const timeline = useRef<HTMLDivElement>(null)
  const drafting = useRef(false)
  const composing = useRef(false)
  const sendInFlight = useRef(false)

  const loadHistory = useCallback(async (): Promise<AssistantBuilderConversationListView> => {
    const next = await callAgentTeam<AssistantBuilderConversationListView>('assistant.builder.list')
    setHistory(next.items)
    return next
  }, [])

  const load = useCallback(async (sessionId?: string) => {
    try {
      if (sessionId !== undefined) {
        const next = await callAgentTeam<AssistantBuilderConversationView>('assistant.builder.get', { sessionId })
        setConversation(next)
        setDraft(undefined)
        drafting.current = false
        await loadHistory()
      } else {
        const nextHistory = await loadHistory()
        const latest = nextHistory.items[0]
        if (latest !== undefined) {
          const next = await callAgentTeam<AssistantBuilderConversationView>('assistant.builder.get', {
            sessionId: latest.sessionId,
          })
          setConversation(next)
          setDraft(undefined)
          drafting.current = false
        } else {
          const next = await callAgentTeam<AssistantBuilderDraftView>('assistant.builder.draft.get')
          setConversation(undefined)
          setDraft(next)
          drafting.current = true
        }
      }
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [loadHistory])

  useEffect(() => {
    void load()
    return subscribeAssistantBuilderConversation(next => {
      if (next !== undefined) {
        setConversation(current => {
          if (current?.sessionId !== next.sessionId) return current
          if (current.status === 'running' && next.status === 'idle') void loadHistory()
          return next
        })
      }
      else if (drafting.current) void loadHistory()
      else void load()
      setError(undefined)
    }, () => {
      setError('实时连接已断开，正在等待重连')
    }, () => {
      setError(undefined)
      if (drafting.current) void loadHistory()
      else void load()
    })
  }, [load, loadHistory])

  useEffect(() => {
    const configuration = conversation?.configuration ?? draft?.configuration
    if (configuration === undefined || modelSelectionDirty) return
    setSelectedProvider(configuration.provider)
    setSelectedModel(configuration.model)
  }, [conversation, draft, modelSelectionDirty])

  useEffect(() => {
    const element = timeline.current
    if (element === null) return
    element.scrollTop = element.scrollHeight
  }, [conversation?.throughSeq, conversation?.nodes.length])

  async function send(): Promise<void> {
    const message = content.trim()
    if (
      message.length === 0
      || !selectedProvider
      || !selectedModel
      || sendInFlight.current
      || (conversation === undefined && draft === undefined)
      || conversation?.status === 'running'
    ) return
    sendInFlight.current = true
    setSending(true)
    try {
      if (conversation === undefined) {
        const next = await callAgentTeam<AssistantBuilderConversationView>('assistant.builder.start', {
          provider: selectedProvider,
          model: selectedModel,
          content: message,
        })
        setConversation(next)
        setDraft(undefined)
        drafting.current = false
        setModelSelectionDirty(false)
      } else {
        await callAgentTeam('assistant.builder.send', {
          sessionId: conversation.sessionId,
          content: message,
        })
      }
      setContent('')
      await loadHistory()
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sendInFlight.current = false
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    if (conversation === undefined) return
    try {
      await callAgentTeam('assistant.builder.stop', { sessionId: conversation.sessionId })
      await load(conversation.sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function applyModel(): Promise<void> {
    if (!selectedProvider || !selectedModel || applyingModel || (conversation === undefined && draft === undefined) || conversation?.status === 'running') return
    setApplyingModel(true)
    try {
      if (conversation === undefined) {
        const next = await callAgentTeam<AssistantBuilderDraftView>('assistant.builder.draft.configure', {
          provider: selectedProvider,
          model: selectedModel,
        })
        setDraft(next)
      } else {
        const next = await callAgentTeam<AssistantBuilderConversationView>('assistant.builder.configure', {
          sessionId: conversation.sessionId,
          provider: selectedProvider,
          model: selectedModel,
        })
        setConversation(next)
      }
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setApplyingModel(false)
    }
  }

  async function createDraft(): Promise<void> {
    if (running || loading || draft !== undefined) return
    setLoading(true)
    try {
      const next = await callAgentTeam<AssistantBuilderDraftView>('assistant.builder.draft.get')
      setConversation(undefined)
      setDraft(next)
      drafting.current = true
      setContent('')
      setModelSelectionDirty(false)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function selectConversation(sessionId: string): Promise<void> {
    if (running || loading || sessionId === conversation?.sessionId) return
    setLoading(true)
    setContent('')
    setDraft(undefined)
    drafting.current = false
    await load(sessionId)
  }

  async function archiveConversation(): Promise<void> {
    const item = archiveCandidate
    if (item === undefined || loading || archivingSessionId !== undefined) return
    setArchivingSessionId(item.sessionId)
    setArchiveError(undefined)
    try {
      await callAgentTeam('assistant.builder.archive', { sessionId: item.sessionId })
      setContent('')
      if (item.sessionId === conversation?.sessionId) {
        setConversation(undefined)
        setLoading(true)
        await load()
      } else {
        await loadHistory()
      }
      setArchiveCandidate(undefined)
      setError(undefined)
    } catch (cause) {
      setArchiveError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setArchivingSessionId(undefined)
      setLoading(false)
    }
  }

  const running = conversation?.status === 'running'
  const providers = catalog?.providers ?? []
  const models = catalog?.models[selectedProvider] ?? []
  const appliedConfiguration = conversation?.configuration ?? draft?.configuration
  const modelChanged = appliedConfiguration !== undefined && (
    selectedProvider !== appliedConfiguration.provider
    || selectedModel !== appliedConfiguration.model
  )
  return (
    <>
      <section className={css.assistantBuilderConversation}>
      <aside className={css.assistantBuilderHistory}>
        <button
          type="button"
          className={css.assistantBuilderNewConversation}
          disabled={loading || running || draft !== undefined}
          onClick={() => { void createDraft() }}
        >
          <IconPlusOutline16 size={14} />
          <span>新对话</span>
        </button>
        <div className={css.assistantBuilderHistoryList}>
          {history.map(item => (
            <div key={item.sessionId} className={css.assistantBuilderHistoryRow}>
              <button
                type="button"
                className={`${css.assistantBuilderHistoryItem} ${item.sessionId === conversation?.sessionId ? css.assistantBuilderHistoryItemActive : ''}`}
                disabled={loading || running || archivingSessionId !== undefined}
                onClick={() => { void selectConversation(item.sessionId) }}
              >
                <strong>{item.title}</strong>
                <span>
                  <time dateTime={item.updatedAt}>{formatConversationTime(item.updatedAt)}</time>
                  <em>{assistantBuilderStateLabel(item.state)}</em>
                </span>
              </button>
              <Tooltip label="归档会话" side="right" delayMs={400}>
                <button
                  type="button"
                  className={css.assistantBuilderHistoryArchive}
                  aria-label={`归档会话 ${item.title}`}
                  disabled={loading || archivingSessionId !== undefined || (running && item.sessionId === conversation?.sessionId)}
                  onClick={() => {
                    setArchiveError(undefined)
                    setArchiveCandidate(item)
                  }}
                >
                  <IconArchiveOutline20 size={14} />
                </button>
              </Tooltip>
            </div>
          ))}
          {!loading && history.length === 0 && <span className={css.assistantBuilderHistoryEmpty}>暂无历史对话</span>}
        </div>
      </aside>
      <div className={css.assistantBuilderMain}>
        <div className={css.assistantBuilderRuntime}>
        <span className={css.assistantBuilderRuntimeState}>
          <span className={`${css.statusDot} ${running ? css.statusRunning : css.statusIdle}`} aria-hidden="true" />
          <span>{loading ? '正在启动…' : running ? '正在思考' : '可以对话'}</span>
        </span>
        <div className={css.assistantBuilderModelControls}>
          <select
            value={selectedProvider}
            onChange={event => {
              const provider = event.target.value
              setSelectedProvider(provider)
              setSelectedModel(catalog?.models[provider]?.[0]?.id ?? '')
              setModelSelectionDirty(true)
            }}
            className={css.assistantBuilderModelSelect}
            aria-label="小助手 Provider"
            disabled={loading || running || applyingModel}
          >
            {providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
          <select
            value={selectedModel}
            onChange={event => {
              setSelectedModel(event.target.value)
              setModelSelectionDirty(true)
            }}
            className={css.assistantBuilderModelSelect}
            aria-label="小助手模型"
            disabled={loading || running || applyingModel}
          >
            {models.map(model => (
              <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name}（${model.id}）`}</option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={!modelChanged || !selectedProvider || !selectedModel || loading || running || applyingModel}
            onClick={() => { void applyModel() }}
          >
            {applyingModel ? '切换中…' : '应用模型'}
          </Button>
        </div>
        </div>
        <div ref={timeline} className={`${css.timeline} ${css.assistantBuilderTimeline}`}>
        {!loading && (draft !== undefined || conversation?.nodes.length === 0) && (
          <article className={`${css.messageNode} ${css.assistantMessage}`}>
            <div className={css.messageText}>
              <MarkdownText text="你好，我是团队 Agent 小助手。告诉我你想创建什么样的助手，以及它主要负责什么；缺少的配置我会逐项询问你。" />
            </div>
          </article>
        )}
        {conversation?.nodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
        </div>
        <form
        className={`${css.composer} ${css.assistantBuilderComposer}`}
        onSubmit={event => { event.preventDefault(); void send() }}
      >
        <textarea
          value={content}
          onChange={event => { setContent(event.target.value) }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (!shouldSubmitComposer({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
            }, composing.current)) return
            event.preventDefault()
            void send()
          }}
          placeholder={running ? '小助手正在回复…' : '例如：我需要一个负责 React 前端开发和代码审查的助手'}
          disabled={loading || running}
          rows={3}
        />
        <div className={css.composerFooter}>
          <span className={css.muted}>Enter 发送 · Shift+Enter 换行</span>
          <div className={css.composerActions}>
            {running && (
              <Tooltip label="停止生成" side="top" delayMs={400}>
                <button type="button" className={css.composerIconButton} onClick={() => { void stop() }} aria-label="停止生成">
                  <IconStopFill16 size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sending ? '发送中…' : '发送消息'} side="top" delayMs={400}>
              <button
                type="submit"
                className={css.composerIconButton}
                disabled={loading || running || sending || !selectedProvider || !selectedModel || content.trim().length === 0}
                aria-label={sending ? '发送中' : '发送消息'}
              >
                <IconSendOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        {error && <span className={css.composerError}>{error}</span>}
        </form>
      </div>
      </section>
      <Modal
        open={archiveCandidate !== undefined}
        onClose={() => {
          if (archivingSessionId === undefined) {
            setArchiveCandidate(undefined)
            setArchiveError(undefined)
          }
        }}
        title="归档会话"
        closeLabel="关闭"
        description="归档后，该会话将不再显示在团队 Agent 小助手的历史记录中。"
        className={css.assistantBuilderArchiveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={archivingSessionId !== undefined}
              onClick={() => {
                setArchiveCandidate(undefined)
                setArchiveError(undefined)
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={archiveCandidate === undefined || archivingSessionId !== undefined}
              onClick={() => { void archiveConversation() }}
            >
              {archivingSessionId !== undefined ? '归档中…' : '确认归档'}
            </Button>
          </>
        )}
      >
        {archiveCandidate !== undefined && (
          <div className={css.assistantBuilderArchiveConfirm}>
            <div className={css.assistantBuilderArchiveIcon} aria-hidden="true">
              <IconArchiveOutline20 size={20} />
            </div>
            <div>
              <strong>{archiveCandidate.title}</strong>
              <p>会话内容不会被删除，底层 Session 日志仍由 Harness 保留。</p>
            </div>
            {archiveError && <div role="alert" className={css.inlineError}>{archiveError}</div>}
          </div>
        )}
      </Modal>
    </>
  )
}

function assistantBuilderStateLabel(state: AssistantBuilderConversationSummary['state']): string {
  if (state === 'completed') return '已创建'
  if (state === 'in_progress') return '配置中'
  return '新对话'
}

function formatConversationTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function AssistantCard({
  assistant,
  onEdit,
  onChanged,
}: {
  assistant: AssistantView
  onEdit: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [deleteOpen, setDeleteOpen] = useState(false)

  async function clone(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('assistant.clone', { id: assistant.id, name: `${assistant.name} Copy` })
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('assistant.delete', { id: assistant.id })
      setDeleteOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <article className={css.card}>
        <div
          className={css.assistantCardContent}
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-label={`编辑助手 ${assistant.name}`}
          onClick={() => { if (!busy) onEdit() }}
          onKeyDown={event => {
            if (busy || (event.key !== 'Enter' && event.key !== ' ')) return
            event.preventDefault()
            onEdit()
          }}
        >
          <strong>{assistant.name}</strong>
          <span className={css.muted}>{assistant.provider} / {assistant.model}</span>
          <span className={css.muted}>
            Preset: {assistant.agentPresetId} · 权限: {PERMISSION_LABELS[assistant.permissionPresetId] ?? assistant.permissionPresetId}
          </span>
          <span className={css.muted}>
            Skills: {assistant.skillAllowlist.length > 0 ? assistant.skillAllowlist.join('、') : '未选择'}
          </span>
          <span className={css.muted}>
            MCP: {assistant.mcpServers.length > 0 ? assistant.mcpServers.join('、') : '未选择'}
          </span>
          {assistant.description && <p className={css.description}>{assistant.description}</p>}
        </div>
        <div className={css.actions}>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={onEdit}>编辑</button>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { void clone() }}>复制</button>
          <button
            type="button"
            className={css.dangerButton}
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setDeleteOpen(true)
            }}
          >
            删除
          </button>
        </div>
        {error && !deleteOpen && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <Modal
        open={deleteOpen}
        onClose={() => {
          if (busy) return
          setDeleteOpen(false)
          setError(undefined)
        }}
        title="删除助手模板"
        closeLabel="关闭"
        description="此操作无法撤销。"
        className={css.assistantDeleteDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDeleteOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void remove() }}
            >
              {busy ? '删除中…' : '确认删除'}
            </button>
          </>
        )}
      >
        <div className={css.assistantDeleteConfirm}>
          <div className={css.assistantDeleteIcon} aria-hidden="true">
            {assistant.name.slice(0, 1).toLocaleUpperCase()}
          </div>
          <div>
            <strong>{assistant.name}</strong>
            <p>删除后不会影响团队或 Workspace。若模板仍被团队成员引用，系统会拒绝删除。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </Modal>
    </>
  )
}

function AssistantForm({
  catalog,
  formId,
  assistant,
  saving,
  setSaving,
  onSaved,
}: {
  catalog: CatalogView | undefined
  formId: string
  assistant?: AssistantView
  saving: boolean
  setSaving: (saving: boolean) => void
  onSaved: () => Promise<void>
}): JSX.Element {
  const providers = catalog?.providers ?? []
  const presets = catalog?.agentPresets.filter(preset => preset.broken === undefined) ?? []
  const permissions = catalog?.permissionPresets ?? []
  const [name, setName] = useState(assistant?.name ?? '')
  const [description, setDescription] = useState(assistant?.description ?? '')
  const [instructions, setInstructions] = useState(assistant?.instructions ?? '')
  const [provider, setProvider] = useState(assistant?.provider ?? providers[0]?.id ?? '')
  const models = catalog?.models[provider] ?? []
  const [modelChoice, setModelChoice] = useState(assistant?.model ?? '')
  const [agentPresetId, setAgentPresetId] = useState(assistant?.agentPresetId ?? presets[0]?.id ?? '')
  const [permissionPresetId, setPermissionPresetId] = useState(assistant?.permissionPresetId ?? permissions[0]?.value ?? '')
  const [availableSkills, setAvailableSkills] = useState<SkillCatalogView['skills']>([])
  const [selectedSkills, setSelectedSkills] = useState<string[]>(assistant?.skillAllowlist ?? [])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsError, setSkillsError] = useState<string>()
  const [availableMcpServers, setAvailableMcpServers] = useState<McpCatalogView['servers']>([])
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>(assistant?.mcpServers ?? [])
  const [mcpLoading, setMcpLoading] = useState(false)
  const [mcpError, setMcpError] = useState<string>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!provider && providers[0]) setProvider(providers[0].id)
    if (!agentPresetId && presets[0]) setAgentPresetId(presets[0].id)
    if (!permissionPresetId && permissions[0]) setPermissionPresetId(permissions[0].value)
  }, [agentPresetId, permissionPresetId, permissions, presets, provider, providers])
  useEffect(() => {
    setModelChoice(current => {
      if (models.some(candidate => candidate.id === current)) return current
      return models[0]?.id ?? ''
    })
  }, [models])
  useEffect(() => {
    let active = true
    if (!agentPresetId) {
      setAvailableSkills([])
      setSelectedSkills([])
      return () => { active = false }
    }
    setSkillsLoading(true)
    setSkillsError(undefined)
    void callAgentTeam<SkillCatalogView>('skill.catalog', { agentPresetId })
      .then(value => {
        if (!active) return
        setAvailableSkills(value.skills)
        const availableNames = new Set(value.skills.map(skill => skill.name))
        setSelectedSkills(current => current.filter(name => availableNames.has(name)))
      })
      .catch(cause => {
        if (!active) return
        setAvailableSkills([])
        setSelectedSkills([])
        setSkillsError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setSkillsLoading(false)
      })
    return () => { active = false }
  }, [agentPresetId])
  useEffect(() => {
    let active = true
    if (!agentPresetId) {
      setAvailableMcpServers([])
      setSelectedMcpServers([])
      return () => { active = false }
    }
    setMcpLoading(true)
    setMcpError(undefined)
    void callAgentTeam<McpCatalogView>('mcp.catalog', { agentPresetId })
      .then(value => {
        if (!active) return
        setAvailableMcpServers(value.servers)
        const availableNames = new Set(value.servers.map(server => server.name))
        setSelectedMcpServers(current => current.filter(name => availableNames.has(name)))
      })
      .catch(cause => {
        if (!active) return
        setAvailableMcpServers([])
        setSelectedMcpServers([])
        setMcpError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setMcpLoading(false)
      })
    return () => { active = false }
  }, [agentPresetId])

  const model = modelChoice

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const value = {
        name,
        ...(assistant === undefined && !description.trim()
          ? {}
          : { description: description.trim() }),
        instructions,
        provider,
        model,
        agentPresetId,
        permissionPresetId,
        skillAllowlist: selectedSkills,
        mcpServers: selectedMcpServers,
      }
      if (assistant === undefined) {
        await callAgentTeam('assistant.create', value)
      } else {
        await callAgentTeam('assistant.update', { id: assistant.id, value }, assistant.revision)
      }
      await onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form id={formId} onSubmit={(event) => { void submit(event) }} className={`${css.form} ${css.assistantForm}`}>
      <div className={css.formGrid}>
        <Field label="名称"><input required value={name} onChange={event => { setName(event.target.value) }} className={css.input} /></Field>
        <Field label="说明"><input value={description} onChange={event => { setDescription(event.target.value) }} className={css.input} /></Field>
        <Field label="Provider">
          <select required value={provider} onChange={event => { setProvider(event.target.value) }} className={css.input}>
            <option value="">请选择</option>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label={`模型（${models.length} 个可选）`}>
          <select required value={modelChoice} onChange={event => { setModelChoice(event.target.value) }} className={css.input}>
            <option value="" disabled>请选择</option>
            {models.map(item => (
              <option key={item.id} value={item.id}>
                {item.name === item.id ? item.id : `${item.name}（${item.id}）`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Agent Preset">
          <select required value={agentPresetId} onChange={event => { setAgentPresetId(event.target.value) }} className={css.input}>
            {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label="权限预设">
          <select required value={permissionPresetId} onChange={event => { setPermissionPresetId(event.target.value) }} className={css.input}>
            {permissions.map(item => (
              <option key={item.value} value={item.value}>
                {PERMISSION_LABELS[item.value] ?? item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="助手规则（可选）" className={css.fullWidth ?? ''}>
          <textarea
            value={instructions}
            onChange={event => { setInstructions(event.target.value) }}
            rows={4}
            placeholder="例如：你负责前端实现；遵循现有代码风格；修改前先阅读相关文件；完成后向 Leader 汇报测试结果。"
            className={css.input}
          />
          <span className={css.hint}>随助手模板保存，在成员启动时加入系统提示词；这里不填写具体任务。</span>
        </Field>
        <Field
          label={`可用 Skills（已选择 ${selectedSkills.length} 个）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="选择助手可使用的 Skills">
            {skillsLoading && <span className={css.hint}>正在读取该 Preset 的 Skills…</span>}
            {!skillsLoading && skillsError && <span className={css.composerError}>{skillsError}</span>}
            {!skillsLoading && !skillsError && availableSkills.length === 0 && (
              <span className={css.hint}>该 Agent Preset 没有可用的 Skill。</span>
            )}
            {!skillsLoading && availableSkills.map(skill => (
              <label key={skill.name} className={css.skillOption}>
                <input
                  type="checkbox"
                  checked={selectedSkills.includes(skill.name)}
                  onChange={event => {
                    setSelectedSkills(current => event.target.checked
                      ? [...current, skill.name].sort()
                      : current.filter(name => name !== skill.name))
                  }}
                />
                <span className={css.skillOptionText}>
                  <strong>{skill.name}</strong>
                  <small>{skill.description}</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>只选择这个助手执行任务时可能需要的 Skills；运行时会按任务需要加载具体 Skill 指令。</span>
        </Field>
        <Field
          label={`可用 MCP（已选择 ${selectedMcpServers.length} 个）`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="选择助手可使用的 MCP Server">
            {mcpLoading && <span className={css.hint}>正在读取该 Preset 的 MCP Server…</span>}
            {!mcpLoading && mcpError && <span className={css.composerError}>{mcpError}</span>}
            {!mcpLoading && !mcpError && availableMcpServers.length === 0 && (
              <span className={css.hint}>当前 Harness 未为该 Agent Preset 配置 MCP Server。</span>
            )}
            {!mcpLoading && availableMcpServers.map(server => (
              <label key={server.name} className={css.skillOption}>
                <input
                  type="checkbox"
                  checked={selectedMcpServers.includes(server.name)}
                  onChange={event => {
                    setSelectedMcpServers(current => event.target.checked
                      ? [...current, server.name].sort()
                      : current.filter(name => name !== server.name))
                  }}
                />
                <span className={css.skillOptionText}>
                  <strong>{server.name}</strong>
                  <small>{server.tools.length} 个工具</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>MCP 连接和密钥由 Harness Profile/Preset 统一管理；运行时只向助手开放已选 Server 的工具。</span>
        </Field>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
    </form>
  )
}

function TeamPanel({
  catalog,
  assistants,
  teams,
  createRequest,
  selectedTeamId,
  pickWorkspace,
  onChanged,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  teams: TeamView[]
  createRequest: number
  selectedTeamId: string | undefined
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
}): JSX.Element {
  const [creating, setCreating] = useState(false)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const visibleTeams = selectedTeamId === undefined
    ? teams
    : teams.filter(team => team.id === selectedTeamId)

  useEffect(() => {
    if (createRequest > 0) setCreating(true)
  }, [createRequest])

  return (
    <section className={css.section}>
      {selectedTeam === undefined && <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>团队 <span className={css.count}>{teams.length}</span></h2>
          <p className={css.sectionDescription}>选择 Leader 和成员，共享同一个 Workspace 协作。</p>
        </div>
        <Button variant="primary" disabled={assistants.length === 0} onClick={() => { setCreating(true) }}>
          组建团队
        </Button>
      </div>}
      {selectedTeam === undefined
        ? visibleTeams.length === 0
          ? <Empty text="还没有团队" hint="先在“设置 → Agent 团队”创建助手，再选择 Leader 和团队成员。" />
          : <div className={css.cardList}>{visibleTeams.map(team => <TeamCard key={team.id} team={team} assistants={assistants} onChanged={onChanged} />)}</div>
        : <TeamWorkbench
          team={selectedTeam}
          assistants={assistants}
          permissionPresets={catalog?.permissionPresets ?? []}
          onChanged={onChanged}
        />}
      <Modal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="新建团队"
        closeLabel="关闭"
        description="让多个 AI 助手组队协作。一个团队必须有且只有一个 Leader。"
        className={css.teamCreateDialog ?? ''}
        contentClassName={css.teamCreateContent ?? ''}
      >
        <TeamForm
          catalog={catalog}
          assistants={assistants}
          pickWorkspace={pickWorkspace}
          onCancel={() => { setCreating(false) }}
          onCreated={async teamId => {
            setCreating(false)
            openTeam(teamId)
            await onChanged()
          }}
        />
      </Modal>
    </section>
  )
}

function TeamWorkbench({
  team,
  assistants,
  permissionPresets,
  onChanged,
}: {
  team: TeamView
  assistants: AssistantView[]
  permissionPresets: CatalogView['permissionPresets']
  onChanged: () => Promise<void>
}): JSX.Element {
  const members = Object.values(team.members)
  const memberIds = members.map(member => member.id)
  const [snapshot, setSnapshot] = useState<TeamWorkbenchView>()
  const [visibleSlots, setVisibleSlots] = useState(() => initialVisibleMemberSlots(memberIds))
  const [error, setError] = useState<string>()
  const [memberActionError, setMemberActionError] = useState<string>()
  const [memberActionBusy, setMemberActionBusy] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<TeamView['members'][string]>()
  const [managementOpen, setManagementOpen] = useState(false)
  const [addMemberOpen, setAddMemberOpen] = useState(false)
  const [expandedSlotId, setExpandedSlotId] = useState<string>()
  const [workspaceRefreshSignal, setWorkspaceRefreshSignal] = useState(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>()
  const loadGeneration = useRef(0)
  const previousMemberIds = useRef(memberIds)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    try {
      const next = await callAgentTeam<TeamWorkbenchView>('team.workbench.get', { id: team.id })
      if (generation !== loadGeneration.current) return
      setSnapshot(next)
      setError(undefined)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [team.id])

  useEffect(() => { void load() }, [load, team.revision])
  useEffect(() => subscribeAgentTeamConversation(team.id, conversation => {
    if (conversation !== undefined) {
      loadGeneration.current += 1
      setWorkspaceRefreshSignal(current => current + 1)
      setSnapshot(current => {
        if (current === undefined) return current
        const conversations = current.conversations.filter(item => item.slotId !== conversation.slotId)
        return { ...current, conversations: [...conversations, conversation] }
      })
      setError(undefined)
      return
    }
    if (refreshTimer.current !== undefined) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined
      void load()
    }, 50)
  }, () => { setError('实时连接已断开，正在等待重连') }, () => {
    setError(undefined)
    void load()
  }), [load, team.id])
  useEffect(() => () => {
    if (refreshTimer.current !== undefined) clearTimeout(refreshTimer.current)
  }, [])
  useEffect(() => {
    setVisibleSlots(current => reconcileVisibleMemberSlots(current, previousMemberIds.current, memberIds))
    previousMemberIds.current = memberIds
  }, [team.members])
  useEffect(() => {
    if (expandedSlotId !== undefined && team.members[expandedSlotId] === undefined) setExpandedSlotId(undefined)
  }, [expandedSlotId, team.members])
  useEffect(() => {
    if (expandedSlotId === undefined) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpandedSlotId(undefined)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => { window.removeEventListener('keydown', closeOnEscape) }
  }, [expandedSlotId])

  function toggleMember(slotId: string): void {
    setVisibleSlots(current => toggleVisibleMemberSlot(current, slotId))
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setMemberActionBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.id,
      }, team.revision)
      setMemberToRemove(undefined)
      setMemberActionError(undefined)
      await onChanged()
      await load()
    } catch (cause) {
      setMemberActionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMemberActionBusy(false)
    }
  }

  const conversations = new Map(snapshot?.conversations.map(item => [item.slotId, item]) ?? [])
  const visibleMembers = visibleSlots.map(slotId => team.members[slotId]).filter((value): value is TeamView['members'][string] => value !== undefined)

  return (
    <div className={css.workbench}>
      <div className={css.memberTabs} aria-label="团队成员">
        {members.map(member => {
          const conversation = conversations.get(member.id)
          const selected = visibleSlots.includes(member.id)
          return (
            <span key={member.id} className={css.memberTabWrap}>
              <button
                type="button"
                className={`${css.memberTab} ${member.role === 'leader' ? '' : css.memberTabWithActions} ${selected ? css.memberTabActive : ''}`}
                onClick={() => { toggleMember(member.id) }}
                aria-pressed={selected}
              >
                <span className={css.memberAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
                <span className={css.memberTabName}>{member.displayName}</span>
                {member.role === 'leader' && <CrownIcon size={15} className={css.leaderCrown} title="Leader" />}
                <span className={`${css.statusDot} ${conversation?.status === 'running' ? css.statusRunning : css.statusIdle}`} />
              </button>
              {member.role !== 'leader' && (
                <span className={css.memberTabActions}>
                  <button
                    type="button"
                    className={css.memberTabRemoveAction}
                    title={`移出成员 ${member.displayName}`}
                    aria-label={`移出成员 ${member.displayName}`}
                    onClick={() => {
                      setMemberActionError(undefined)
                      setMemberToRemove(member)
                    }}
                  >
                    <IconCloseOutline16 size={12} />
                  </button>
                </span>
              )}
            </span>
          )
        })}
        <span className={css.manageButtonWrap}>
          <Button
            variant="ghost"
            size="sm"
            className={css.manageButton}
            disabled={assistants.length === 0}
            onClick={() => {
              setAddMemberOpen(true)
            }}
          >
            <IconPlusOutline16 size={14} />
            添加助手
          </Button>
          <Button variant="ghost" size="sm" className={css.manageButton} onClick={() => { setManagementOpen(value => !value) }}>
            {managementOpen ? '收起管理' : '团队管理'}
          </Button>
        </span>
      </div>
      {error && <div role="alert" className={css.workbenchError}>{error}</div>}
      {memberActionError && memberToRemove === undefined && (
        <div role="alert" className={css.workbenchError}>{memberActionError}</div>
      )}
      {expandedSlotId !== undefined && (
        <button
          type="button"
          className={css.conversationFocusBackdrop}
          aria-label="关闭放大对话"
          onClick={() => { setExpandedSlotId(undefined) }}
        />
      )}
      <div className={css.workbenchBody}>
        <div className={css.conversationGrid} style={{ '--member-columns': visibleMembers.length } as React.CSSProperties}>
          {visibleMembers.map(member => (
            <ConversationColumn
              key={member.id}
              team={team}
              member={member}
              conversation={conversations.get(member.id)}
              permissionPresets={permissionPresets}
              onSent={load}
              onTeamChanged={onChanged}
              expanded={expandedSlotId === member.id}
              onExpandedChange={expanded => { setExpandedSlotId(expanded ? member.id : undefined) }}
            />
          ))}
        </div>
        <WorkspacePanel team={team} refreshSignal={workspaceRefreshSignal} />
      </div>
      <Modal
        open={managementOpen}
        onClose={() => { setManagementOpen(false) }}
        title="团队管理"
        description="管理成员、Leader、上下文和团队生命周期。"
        closeLabel="关闭"
        className={css.managementDialog ?? ''}
        contentClassName={css.managementDialogContent ?? ''}
      >
        <div className={css.managementDialogBody}>
          <TeamCard team={team} assistants={assistants} onChanged={async () => { await onChanged(); await load() }} compact />
        </div>
      </Modal>
      <AddTeamMemberDialog
        open={addMemberOpen}
        team={team}
        assistants={assistants}
        onClose={() => { setAddMemberOpen(false) }}
        onChanged={async () => { await onChanged(); await load() }}
      />
      <Modal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (memberActionBusy) return
          setMemberToRemove(undefined)
          setMemberActionError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={memberActionBusy}
              onClick={() => {
                setMemberToRemove(undefined)
                setMemberActionError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={memberActionBusy}
              onClick={() => { void removeMember() }}
            >
              {memberActionBusy ? '移出中…' : '确认移出'}
            </button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>确定移出“{memberToRemove?.displayName}”？</strong>
            <p>该成员将停止参与团队；若仍有未完成任务，系统会阻止移出。助手模板和 Session 历史都会保留。</p>
          </div>
          {memberActionError && <div role="alert" className={css.inlineError}>{memberActionError}</div>}
        </div>
      </Modal>
    </div>
  )
}

function ConversationColumn({
  team,
  member,
  conversation,
  permissionPresets,
  onSent,
  onTeamChanged,
  expanded,
  onExpandedChange,
}: {
  team: TeamView
  member: TeamView['members'][string]
  conversation: MemberConversationView | undefined
  permissionPresets: CatalogView['permissionPresets']
  onSent: () => Promise<void>
  onTeamChanged: () => Promise<void>
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): JSX.Element {
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [changingPermission, setChangingPermission] = useState(false)
  const [permissionPresetId, setPermissionPresetId] = useState(member.permissionPresetId)
  const [error, setError] = useState<string>()
  const [pendingMessages, setPendingMessages] = useState<ConversationNode[]>([])
  const [uploadingFiles, setUploadingFiles] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileInsertionPoint = useRef({ start: 0, end: 0 })
  const timelineRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const composing = useRef(false)
  const sendInFlight = useRef(false)
  const canChat = team.state === 'active' && (member.role === 'leader' || team.directMemberChat)
  const running = conversation?.status === 'running'
  const visibleNodes = mergeConversationNodes(conversation?.nodes ?? [], pendingMessages)

  useEffect(() => {
    setPermissionPresetId(member.permissionPresetId)
  }, [member.permissionPresetId])

  useEffect(() => {
    const committedIds = new Set(conversation?.nodes.map(node => node.id) ?? [])
    setPendingMessages(current => {
      const next = current.filter(node => !committedIds.has(node.id))
      return next.length === current.length ? current : next
    })
  }, [conversation?.throughSeq])

  useEffect(() => {
    if (!stickToBottom.current) return
    const frame = requestAnimationFrame(() => {
      const timeline = timelineRef.current
      if (timeline !== null) timeline.scrollTop = timeline.scrollHeight
    })
    return () => { cancelAnimationFrame(frame) }
  }, [conversation?.throughSeq, pendingMessages.length])

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault()
    const message = content.trim()
    if (!message || sendInFlight.current) return
    const pendingId = `pending:${crypto.randomUUID()}`
    const pending: ConversationNode = {
      id: pendingId,
      kind: 'user',
      seq: Number.MAX_SAFE_INTEGER,
      time: Date.now(),
      text: message,
    }
    sendInFlight.current = true
    setSending(true)
    setContent('')
    setPendingMessages(current => [...current, pending])
    stickToBottom.current = true
    try {
      const delivered = await callAgentTeam<{ id: string }>('team.message.send', {
        teamId: team.id,
        targetSlotId: member.id,
        content: message,
      })
      setPendingMessages(current => current.map(node => node.id === pendingId ? { ...node, id: delivered.id } : node))
      setError(undefined)
      await onSent()
    } catch (cause) {
      setPendingMessages(current => current.filter(node => node.id !== pendingId))
      setContent(current => current.length === 0 ? message : current)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      sendInFlight.current = false
      setSending(false)
    }
  }

  async function stop(): Promise<void> {
    if (stopping) return
    setStopping(true)
    try {
      await callAgentTeam('team.member.stop', { teamId: team.id, slotId: member.id })
      setError(undefined)
      await onSent()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStopping(false)
    }
  }

  async function changePermission(nextPermissionPresetId: string): Promise<void> {
    if (changingPermission || nextPermissionPresetId === permissionPresetId) return
    const previous = permissionPresetId
    setPermissionPresetId(nextPermissionPresetId)
    setChangingPermission(true)
    try {
      await callAgentTeam('team.member.setPermissionPreset', {
        teamId: team.id,
        slotId: member.id,
        permissionPresetId: nextPermissionPresetId,
      })
      setError(undefined)
      await onTeamChanged()
    } catch (cause) {
      setPermissionPresetId(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChangingPermission(false)
    }
  }

  async function uploadFiles(files: FileList | null): Promise<void> {
    const selected = Array.from(files ?? [])
    if (selected.length === 0 || uploadingFiles) return
    setUploadingFiles(true)
    try {
      const uploads: WorkspaceUploadView[] = []
      for (const file of selected) uploads.push(await uploadAgentTeamFile(team.id, file))
      let nextCursor = fileInsertionPoint.current.start
      setContent(current => {
        let nextValue = current
        let selectionStart = Math.min(fileInsertionPoint.current.start, current.length)
        let selectionEnd = Math.min(fileInsertionPoint.current.end, current.length)
        for (const upload of uploads) {
          const inserted = insertWorkspaceFileMention(nextValue, selectionStart, selectionEnd, upload.path)
          nextValue = inserted.value
          nextCursor = inserted.cursor
          selectionStart = inserted.cursor
          selectionEnd = inserted.cursor
        }
        return nextValue
      })
      setError(undefined)
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        textareaRef.current?.setSelectionRange(nextCursor, nextCursor)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (fileInputRef.current !== null) fileInputRef.current.value = ''
      setUploadingFiles(false)
    }
  }

  return (
    <section
      className={`${css.conversationColumn} ${expanded ? css.conversationColumnExpanded : ''}`}
      aria-label={`${member.displayName} 对话`}
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
    >
      <header
        className={css.columnHeader}
        title={expanded ? undefined : '双击放大对话'}
        onDoubleClick={() => { if (!expanded) onExpandedChange(true) }}
      >
        <div className={css.columnIdentity}>
          <span className={css.memberAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
          <div>
            <strong>{member.displayName} {member.role === 'leader' && <CrownIcon size={15} className={css.leaderCrown} title="Leader" />}</strong>
            <span>{member.assistantSnapshot.provider} / {member.assistantSnapshot.model}</span>
          </div>
        </div>
        <div className={css.columnHeaderActions}>
          <span className={css.columnStatus}>{statusLabel(conversation?.status ?? member.lastRuntimeState)}</span>
          {expanded && (
            <Tooltip label="关闭放大对话" side="bottom" delayMs={400}>
              <button
                type="button"
                className={css.columnExpandClose}
                aria-label="关闭放大对话"
                onDoubleClick={event => { event.stopPropagation() }}
                onClick={() => { onExpandedChange(false) }}
              >
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          )}
        </div>
      </header>
      <div
        className={css.timeline}
        ref={timelineRef}
        onScroll={event => {
          const timeline = event.currentTarget
          stickToBottom.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
        }}
      >
        {visibleNodes.length === 0
          ? <div className={css.columnEmpty}>
            <span className={css.emptyAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
            <strong>{member.displayName}</strong>
            <span>{member.role === 'leader' ? '向 Leader 描述目标，由它组织团队协作。' : '等待 Leader 分配任务，或直接向该成员发送消息。'}</span>
          </div>
          : visibleNodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
      </div>
      <form className={css.composer} onSubmit={(event) => { void send(event) }}>
        <textarea
          ref={textareaRef}
          value={content}
          onChange={event => { setContent(event.target.value) }}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false }}
          onKeyDown={event => {
            if (!shouldSubmitComposer({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.nativeEvent.keyCode,
            }, composing.current)) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
          disabled={!canChat || uploadingFiles}
          placeholder={!canChat ? '当前不可直接对话' : `发送消息到 ${member.displayName}…`}
          rows={2}
        />
        <div className={css.composerFooter}>
          <div className={css.composerUtilities}>
            <button
              type="button"
              className={`${css.composerIconButton} ${css.composerAttachButton}`}
              disabled={!canChat || uploadingFiles}
              aria-label={uploadingFiles ? '正在上传文件' : '选择文件'}
              onClick={() => {
                const textarea = textareaRef.current
                fileInsertionPoint.current = {
                  start: textarea?.selectionStart ?? content.length,
                  end: textarea?.selectionEnd ?? content.length,
                }
                fileInputRef.current?.click()
              }}
            >
              <IconPaperclipOutline16 size={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              className={css.hiddenFileInput}
              multiple
              tabIndex={-1}
              onChange={event => { void uploadFiles(event.currentTarget.files) }}
            />
            <select
              className={css.permissionSelect}
              aria-label={`${member.displayName} 权限`}
              value={permissionPresetId}
              disabled={changingPermission || permissionPresets.length === 0}
              onChange={event => { void changePermission(event.target.value) }}
            >
              {permissionPresets.map(permission => (
                <option key={permission.value} value={permission.value}>
                  权限 · {PERMISSION_LABELS[permission.value] ?? permission.name}
                </option>
              ))}
            </select>
          </div>
          <div className={css.composerActions}>
            {running && (
              <Tooltip label={stopping ? '停止中…' : '停止生成'} side="top" delayMs={400}>
                <button
                  type="button"
                  className={css.composerIconButton}
                  disabled={stopping}
                  aria-label={stopping ? '停止中' : '停止生成'}
                  onClick={() => { void stop() }}
                >
                  <IconStopFill16 size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sending ? '发送中…' : '发送消息'} side="top" delayMs={400}>
              <button
                type="submit"
                className={css.composerIconButton}
                disabled={!canChat || sending || uploadingFiles || !content.trim()}
                aria-label={sending ? '发送中' : '发送消息'}
              >
                <IconSendOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        {error && <span className={css.composerError}>{error}</span>}
      </form>
    </section>
  )
}

function ConversationNodeView({ node }: { node: ConversationNode }): JSX.Element {
  if (node.kind === 'tool') return <ToolCard node={node} />
  if (node.kind === 'notice') return <div className={`${css.noticeNode} ${node.tone === 'error' ? css.noticeError : ''}`}>{node.text}</div>
  if (node.kind === 'team-message') return <TeamMessageCard node={node} />
  return (
    <article className={`${css.messageNode} ${node.kind === 'user' ? css.userMessage : css.assistantMessage}`}>
      {node.reasoning && (
        <details className={css.reasoningBlock}>
          <summary>思考过程</summary>
          <pre>{node.reasoning}</pre>
        </details>
      )}
      {node.text && (
        <div className={css.messageText}>
          {node.kind === 'assistant'
            ? <MarkdownText text={node.text} streaming={node.streaming === true} />
            : <MessageText text={node.text} />}
        </div>
      )}
      {node.streaming && <span className={css.streamingMark}>生成中…</span>}
    </article>
  )
}

const TEAM_MESSAGE_TYPE_LABELS: Record<Extract<ConversationNode, { kind: 'team-message' }>['messageType'], string> = {
  instruction: '指令',
  progress: '进度',
  result: '结果',
  question: '问题',
  warning: '警告',
  system: '系统',
}

function TeamMessageCard({ node }: { node: Extract<ConversationNode, { kind: 'team-message' }> }): JSX.Element {
  const toneClass = node.messageType === 'result'
    ? css.teamMessageResult
    : node.messageType === 'question'
      ? css.teamMessageQuestion
      : node.messageType === 'warning'
        ? css.teamMessageWarning
        : node.messageType === 'instruction'
          ? css.teamMessageInstruction
          : node.messageType === 'system'
            ? css.teamMessageSystem
            : css.teamMessageProgress
  const category = node.senderRole === 'leader'
    ? 'Leader 消息'
    : node.senderRole === 'system'
      ? '团队事件'
      : '成员反馈'
  return (
    <article className={`${css.teamMessageCard} ${toneClass}`}>
      <header className={css.teamMessageHeader}>
        <span className={css.teamMessageIdentity}>
          <strong>{category}</strong>
          {node.senderRole !== 'system' && <span>{node.senderName}</span>}
          {node.senderRole !== 'system' && (
            <code className={css.teamMessageMemberId} title={`成员 ID：${node.senderId}`}>
              ID {shortMemberId(node.senderId)}
            </code>
          )}
        </span>
        <span className={css.teamMessageType}>{TEAM_MESSAGE_TYPE_LABELS[node.messageType]}</span>
      </header>
      <div className={css.teamMessageText}><MessageText text={node.text} /></div>
    </article>
  )
}

function shortMemberId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function ToolCard({ node }: { node: Extract<ConversationNode, { kind: 'tool' }> }): JSX.Element {
  const status = node.status === 'running' ? '执行中' : node.status === 'success' ? '已完成' : '失败'
  return (
    <details className={`${css.toolCard} ${node.status === 'error' ? css.toolCardError : ''}`} open={node.status !== 'success'}>
      <summary>
        <span className={css.toolIcon}>⌘</span>
        <strong>{node.name}</strong>
        <span>{status}</span>
      </summary>
      {node.arguments && <div className={css.toolSection}><span>参数</span><pre>{prettyJson(node.arguments)}</pre></div>}
      {node.result && <div className={css.toolSection}><span>结果</span><pre>{node.result}</pre></div>}
      {node.error && <div className={css.toolError}>{node.error}</div>}
    </details>
  )
}

function WorkspacePanel({ team, refreshSignal }: { team: TeamView; refreshSignal: number }): JSX.Element {
  const [entries, setEntries] = useState<WorkspaceEntryView[]>([])
  const [error, setError] = useState<string>()
  const [refreshing, setRefreshing] = useState(false)
  const [treeRefreshToken, setTreeRefreshToken] = useState(0)
  const loadGeneration = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current
    setRefreshing(true)
    try {
      const next = await callAgentTeam<WorkspaceEntryView[]>('team.workspace.list', { teamId: team.id })
      if (generation !== loadGeneration.current) return
      setEntries(next)
      setTreeRefreshToken(current => current + 1)
      setError(undefined)
    } catch (cause) {
      if (generation !== loadGeneration.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (generation === loadGeneration.current) setRefreshing(false)
    }
  }, [team.id])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (refreshSignal === 0) return
    const timer = setTimeout(() => { void load() }, 600)
    return () => { clearTimeout(timer) }
  }, [load, refreshSignal])
  return (
    <aside className={css.workspacePanel}>
      <div className={css.workspaceHeader}>
        <div><strong>Workspace</strong><span>{team.workspacePath}</span></div>
        <div className={css.workspaceHeaderActions}>
          <span>{entries.length}</span>
          <Tooltip label={refreshing ? '刷新中…' : '刷新目录'} side="bottom" delayMs={400}>
            <button
              type="button"
              className={`${css.workspaceRefreshButton} ${refreshing ? css.workspaceRefreshButtonBusy : ''}`}
              disabled={refreshing}
              aria-label={refreshing ? '正在刷新 Workspace 目录' : '刷新 Workspace 目录'}
              onClick={() => { void load() }}
            >
              <IconRefreshOutline16 size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className={css.fileTree}>
        {entries.map(entry => (
          <WorkspaceTreeRow
            key={entry.path}
            teamId={team.id}
            entry={entry}
            depth={0}
            refreshToken={treeRefreshToken}
          />
        ))}
        {entries.length === 0 && !error && <span className={css.fileEmpty}>{refreshing ? '正在读取目录…' : '目录为空'}</span>}
        {error && <span className={css.fileError}>{error}</span>}
      </div>
      <div className={css.workspaceTasks}>
        <strong>任务板</strong>
        {Object.values(team.tasks).slice(0, 8).map(task => (
          <div key={task.id}><span>{task.title}</span><em>{TASK_STATE_LABELS[task.status] ?? task.status}</em></div>
        ))}
        {Object.keys(team.tasks).length === 0 && <span className={css.fileEmpty}>暂无任务</span>}
      </div>
    </aside>
  )
}

function WorkspaceTreeRow({
  teamId,
  entry,
  depth,
  refreshToken,
}: {
  teamId: string
  entry: WorkspaceEntryView
  depth: number
  refreshToken: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<WorkspaceEntryView[]>()
  useEffect(() => {
    if (!open || entry.kind !== 'directory') return
    let active = true
    void callAgentTeam<WorkspaceEntryView[]>('team.workspace.list', { teamId, path: entry.path })
      .then(next => { if (active) setChildren(next) })
      .catch(() => { if (active) setChildren([]) })
    return () => { active = false }
  }, [entry.kind, entry.path, open, refreshToken, teamId])
  function toggle(): void {
    if (entry.kind === 'directory') setOpen(current => !current)
  }
  return (
    <div>
      <button type="button" className={css.fileRow} style={{ paddingLeft: 8 + depth * 14 }} onClick={toggle}>
        <span>{entry.kind === 'directory' ? open ? '▾' : '▸' : entry.kind === 'symlink' ? '↗' : '·'}</span>
        <span>{entry.kind === 'directory' ? '📁' : '▧'}</span>
        <span>{entry.name}</span>
      </button>
      {open && children?.map(child => (
        <WorkspaceTreeRow
          key={child.path}
          teamId={teamId}
          entry={child}
          depth={depth + 1}
          refreshToken={refreshToken}
        />
      ))}
    </div>
  )
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    offline: '离线', starting: '启动中', idle: '空闲', running: '运行中',
    waiting_approval: '等待审批', error: '异常',
  }
  return labels[status] ?? status
}

function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}

function AddTeamMemberDialog({
  open,
  team,
  assistants,
  onClose,
  onChanged,
}: {
  open: boolean
  team: TeamView
  assistants: AssistantView[]
  onClose: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [addingAssistantId, setAddingAssistantId] = useState<string>()
  const [error, setError] = useState<string>()

  async function addMember(assistant: AssistantView): Promise<void> {
    setAddingAssistantId(assistant.id)
    try {
      await callAgentTeam('team.addMember', {
        teamId: team.id,
        value: { assistantId: assistant.id },
      }, team.revision)
      setError(undefined)
      onClose()
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAddingAssistantId(undefined)
    }
  }

  function close(): void {
    if (addingAssistantId !== undefined) return
    setError(undefined)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="添加助手"
      description={`选择一个助手加入团队“${team.name}”。同一个助手可以多次加入。`}
      closeLabel="关闭"
      className={css.addMemberDialog ?? ''}
      contentClassName={css.addMemberDialogContent ?? ''}
    >
      <div className={css.addMemberDialogHeader}>
        <strong>助手列表</strong>
        <span>{assistants.length} 个助手</span>
      </div>
      <div className={css.addMemberMenuList}>
        {assistants.map(assistant => (
          <button
            key={assistant.id}
            type="button"
            className={css.addMemberOption}
            disabled={addingAssistantId !== undefined}
            onClick={() => { void addMember(assistant) }}
          >
            <span className={css.addMemberAvatar}>{assistant.name.slice(0, 1).toUpperCase()}</span>
            <span className={css.addMemberCopy}>
              <strong>{assistant.name}</strong>
              <span>{assistant.provider} / {assistant.model}</span>
            </span>
            <span className={css.addMemberOptionAction}>
              {addingAssistantId === assistant.id ? '添加中…' : <IconPlusOutline16 size={14} />}
            </span>
          </button>
        ))}
        {assistants.length === 0 && <span className={css.fileEmpty}>还没有可添加的助手模板</span>}
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
    </Modal>
  )
}

function TeamCard({
  team,
  assistants,
  onChanged,
  compact = false,
}: {
  team: TeamView
  assistants: AssistantView[]
  onChanged: () => Promise<void>
  compact?: boolean
}): JSX.Element {
  const [content, setContent] = useState('')
  const [targetSlotId, setTargetSlotId] = useState(team.leaderSlotId)
  const [busy, setBusy] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [dissolveOpen, setDissolveOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<{ slotId: string; displayName: string }>()
  const [error, setError] = useState<string>()
  const members = Object.values(team.members)
  const tasks = Object.values(team.tasks)
  const executing = isTeamExecuting(team)

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    try {
      await callAgentTeam('team.message.send', { teamId: team.id, targetSlotId, content })
      setContent('')
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function dissolve(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.dissolve', { teamId: team.id, confirmation: team.name })
      setDissolveOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function resetTeam(): Promise<void> {
    setBusy(true)
    try {
      await callAgentTeam('team.reset', { teamId: team.id, confirmation: team.name }, team.revision)
      setResetOpen(false)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function removeMember(): Promise<void> {
    if (memberToRemove === undefined) return
    setBusy(true)
    try {
      await callAgentTeam('team.removeMember', {
        teamId: team.id,
        slotId: memberToRemove.slotId,
      }, team.revision)
      setMemberToRemove(undefined)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function changeLeader(successorSlotId: string): Promise<void> {
    if (successorSlotId === team.leaderSlotId) return
    setBusy(true)
    try {
      await callAgentTeam('team.changeLeader', {
        teamId: team.id,
        successorSlotId,
      }, team.revision)
      setError(undefined)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <article className={`${css.card} ${compact ? css.managementCard : ''}`}>
      <header className={css.teamCardHeader}>
        <div className={css.teamCardIdentity}>
          <strong className={css.teamCardName}>{team.name}</strong>
          <span className={css.teamCardWorkspace}>{team.workspacePath}</span>
        </div>
        {executing && <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>任务执行中</span>}
      </header>

      <section className={css.teamMemberSection} aria-label="团队成员">
        <div className={css.teamSectionHeader}>
          <strong>团队成员</strong>
          <span className={css.teamSectionActions}>
            <span>{members.length} 人</span>
            <button
              type="button"
              className={css.addMemberButton}
              disabled={busy || assistants.length === 0}
              onClick={() => { setAddingMember(true) }}
            >
              <IconPlusOutline16 size={14} />
              添加助手
            </button>
          </span>
        </div>
        <div className={css.memberGrid}>
          {members.map(member => (
            <div key={member.id} className={`${css.memberTile} ${member.role === 'leader' ? css.memberTileLeader : ''}`}>
              <span className={css.memberTileAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
              <span className={css.memberTileCopy}>
                <span className={css.memberTileName} title={member.displayName}>{member.displayName}</span>
                <span className={css.memberRuntime}>
                  <span className={`${css.statusDot} ${member.lastRuntimeState === 'running' ? css.statusRunning : css.statusIdle}`} />
                  {statusLabel(member.lastRuntimeState)}
                </span>
              </span>
              <span className={css.memberTileActions}>
                {member.role === 'leader'
                  ? <span className={`${css.memberRole} ${css.memberRoleLeader}`}>Leader</span>
                  : <button
                    type="button"
                    className={`${css.memberRole} ${css.memberRoleAction}`}
                    disabled={busy}
                    onClick={() => { void changeLeader(member.id) }}
                  >
                    设为 Leader
                  </button>}
                {member.id !== team.leaderSlotId && (
                  <button
                    type="button"
                    className={css.memberRemoveButton}
                    disabled={busy}
                    onClick={() => {
                      setError(undefined)
                      setMemberToRemove({ slotId: member.id, displayName: member.displayName })
                    }}
                  >
                    移出
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
      {tasks.length > 0 && (
        <div className={css.taskList}>
          <strong className={css.taskTitle}>任务板</strong>
          {tasks.map(task => (
            <div key={task.id} className={css.memberRow}>
              <span>{task.title}</span>
              <span className={css.muted}>{TASK_STATE_LABELS[task.status] ?? task.status}{task.ownerSlotId ? ` · ${team.members[task.ownerSlotId]?.displayName ?? '已移除成员'}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {team.state === 'active' && !compact && (
        <form onSubmit={(event) => { void send(event) }} className={css.messageForm}>
          <select value={targetSlotId} onChange={event => { setTargetSlotId(event.target.value) }} className={css.compactInput}>
            {members
              .filter(member => member.role === 'leader' || team.directMemberChat)
              .map(member => <option key={member.id} value={member.id}>{member.displayName}（{member.role === 'leader' ? '负责人' : '成员'}）</option>)}
          </select>
          <input required value={content} onChange={event => { setContent(event.target.value) }} placeholder="发送任务或消息" className={css.compactInput} />
          <button type="submit" className={css.primaryButton} disabled={busy}>发送</button>
        </form>
      )}
      {team.state !== 'deleting' && team.state !== 'delete_blocked' && (
        <div className={css.contextResetPanel}>
          <div className={css.contextResetCopy}>
            <strong>清空任务与上下文</strong>
            <span>停止所有成员并清空任务板，为每位成员换用全新 Session。Workspace 文件和团队配置不变。</span>
          </div>
          <button
            type="button"
            className={css.dangerButton}
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setResetOpen(true)
            }}
          >
            {busy ? '处理中…' : '清空'}
          </button>
        </div>
      )}
      <div className={`${css.contextResetPanel} ${css.dissolvePanel}`}>
        <div className={css.contextResetCopy}>
          <strong>解散团队</strong>
          <span>永久删除团队、任务和团队消息；助手模板与 Workspace 文件保留，旧 Session 日志不再恢复。</span>
        </div>
        <button
          type="button"
          className={css.dangerButton}
          disabled={busy || team.state === 'deleting'}
          onClick={() => {
            setError(undefined)
            setDissolveOpen(true)
          }}
        >
          {team.state === 'deleting' ? '解散中…' : team.state === 'delete_blocked' ? '重试解散' : '解散团队'}
        </button>
      </div>
        {error && !dissolveOpen && !resetOpen && memberToRemove === undefined && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <AddTeamMemberDialog
        open={addingMember}
        team={team}
        assistants={assistants}
        onClose={() => { setAddingMember(false) }}
        onChanged={onChanged}
      />
      <Modal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (busy) return
          setMemberToRemove(undefined)
          setError(undefined)
        }}
        title="移出团队成员"
        closeLabel="关闭"
        description="该成员将停止参与当前团队。"
        className={css.memberRemoveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setMemberToRemove(undefined)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void removeMember() }}
            >
              {busy ? '移出中…' : '确认移出'}
            </button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>确定移出“{memberToRemove?.displayName}”？</strong>
            <p>该成员将停止参与团队；若仍有未完成任务，系统会阻止移出。助手模板和 Session 历史都会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </Modal>
      <Modal
        open={resetOpen}
        onClose={() => {
          if (busy) return
          setResetOpen(false)
          setError(undefined)
        }}
        title="清空任务与上下文"
        closeLabel="关闭"
        description="所有成员将换用全新的对话上下文。"
        className={css.teamResetDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setResetOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void resetTeam() }}
            >
              {busy ? '清空中…' : '确认清空'}
            </button>
          </>
        )}
      >
        <div className={css.teamResetConfirm}>
          <div className={css.teamResetIcon} aria-hidden="true">↻</div>
          <div>
            <strong>确定清空“{team.name}”的任务与上下文？</strong>
            <p>所有成员会停止，任务板和待处理消息会被清空，并换用全新 Session。Workspace 文件、团队配置和旧 Session 日志会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </Modal>
      <Modal
        open={dissolveOpen}
        onClose={() => {
          if (busy) return
          setDissolveOpen(false)
          setError(undefined)
        }}
        title="解散团队"
        closeLabel="关闭"
        description="此操作无法撤销。"
        className={css.teamDissolveDialog ?? ''}
        footer={(
          <>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDissolveOpen(false)
                setError(undefined)
              }}
            >
              取消
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void dissolve() }}
            >
              {busy ? '解散中…' : '确认解散'}
            </button>
          </>
        )}
      >
        <div className={css.teamDissolveConfirm}>
          <div className={css.teamDissolveIcon} aria-hidden="true">!</div>
          <div>
            <strong>确定解散“{team.name}”？</strong>
            <p>所有成员将停止，团队任务、消息和配置会被永久删除。助手模板与 Workspace 文件会保留。</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </Modal>
    </>
  )
}

interface DraftMember {
  key: string
  assistantId: string
}

function TeamForm({
  catalog,
  assistants,
  pickWorkspace,
  onCancel,
  onCreated,
}: {
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onCancel: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspace.status === 'ok') ?? []
  const [name, setName] = useState('')
  const [workspaceId, setWorkspaceId] = useState(catalogWorkspaces[0]?.id ?? '')
  const [pickedWorkspace, setPickedWorkspace] = useState<WorkspaceChoice>()
  const [query, setQuery] = useState('')
  const [members, setMembers] = useState<DraftMember[]>([])
  const [leaderKey, setLeaderKey] = useState<string>()
  const [directMemberChat, setDirectMemberChat] = useState(true)
  const [saving, setSaving] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [error, setError] = useState<string>()
  const workspaces = useMemo(() => {
    if (pickedWorkspace === undefined || catalogWorkspaces.some(workspace => workspace.id === pickedWorkspace.id)) {
      return catalogWorkspaces
    }
    return [...catalogWorkspaces, { ...pickedWorkspace, status: 'ok' as const }]
  }, [catalogWorkspaces, pickedWorkspace])
  const byId = useMemo(() => new Map(assistants.map(assistant => [assistant.id, assistant])), [assistants])
  const filteredAssistants = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    if (!normalized) return assistants
    return assistants.filter(assistant => [assistant.name, assistant.description, assistant.provider, assistant.model]
      .some(value => value?.toLocaleLowerCase().includes(normalized)))
  }, [assistants, query])

  useEffect(() => { if (!workspaceId && workspaces[0]) setWorkspaceId(workspaces[0].id) }, [workspaceId, workspaces])

  async function chooseWorkspace(): Promise<void> {
    setPickingWorkspace(true)
    try {
      const workspace = await pickWorkspace()
      if (workspace === null) return
      setPickedWorkspace(workspace)
      setWorkspaceId(workspace.id)
      setError(undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPickingWorkspace(false)
    }
  }

  function addAssistant(assistant: AssistantView): void {
    const member: DraftMember = {
      key: crypto.randomUUID(),
      assistantId: assistant.id,
    }
    setMembers(current => [...current, member])
    setLeaderKey(current => current ?? member.key)
  }

  function removeMember(key: string): void {
    const remaining = members.filter(member => member.key !== key)
    setMembers(remaining)
    if (leaderKey === key) setLeaderKey(remaining[0]?.key)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (leaderKey === undefined || members.length === 0) return
    setSaving(true)
    try {
      const draft = await callAgentTeam<TeamView>('team.createDraft', {
        name,
        workspaceId,
        directMemberChat,
        members: members.map(member => ({
          assistantId: member.assistantId,
          role: member.key === leaderKey ? 'leader' : 'member',
        })),
      })
      await callAgentTeam<TeamView>('team.start', { id: draft.id }, draft.revision)
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const canSubmit = name.trim().length > 0
    && workspaceId.length > 0
    && leaderKey !== undefined
    && members.length > 0

  return (
    <form onSubmit={(event) => { void submit(event) }} className={css.teamBuilderForm}>
      <div className={css.teamBuilderGrid}>
        <section className={css.assistantPicker}>
          <div className={css.builderSectionHeading}>
            <strong>所有助手 <span className={css.count}>{assistants.length}</span></strong>
          </div>
          <input
            type="search"
            value={query}
            onChange={event => { setQuery(event.target.value) }}
            placeholder="搜索助手、Provider 或模型"
            aria-label="搜索助手"
            className={css.builderSearch}
          />
          <div className={css.assistantPickList}>
            {filteredAssistants.map(assistant => (
              <div key={assistant.id} className={css.assistantPickRow}>
                <div className={css.assistantPickAvatar} aria-hidden="true">
                  {assistant.name.slice(0, 1).toLocaleUpperCase()}
                </div>
                <div className={css.assistantPickCopy}>
                  <strong>{assistant.name}</strong>
                  <span>{assistant.provider} / {assistant.model}</span>
                </div>
                <button
                  type="button"
                  className={css.assistantAddButton}
                  onClick={() => { addAssistant(assistant) }}
                  aria-label={`添加 ${assistant.name}`}
                >
                  <IconPlusOutline16 size={16} />
                </button>
              </div>
            ))}
            {filteredAssistants.length === 0 && <Empty text="没有匹配的助手" />}
          </div>
        </section>

        <section className={css.selectedMembers}>
          <div className={css.builderSectionHeading}>
            <div>
              <strong>已选成员 {members.length}</strong>
              <p>选择团队成员并指定一个 Leader。同一助手可多次选择。</p>
            </div>
            <span className={css.leaderLegend}>Leader</span>
          </div>
          <div className={css.selectedMemberList}>
            {members.length === 0
              ? (
                  <div className={css.memberEmpty}>
                    <strong>至少选择一个助手当团队 Leader。</strong>
                    <span>从左侧助手列表添加成员。</span>
                  </div>
                )
              : members.map(member => {
                  const assistant = byId.get(member.assistantId)
                  const leader = member.key === leaderKey
                  return (
                    <div key={member.key} className={`${css.selectedMemberRow} ${leader ? css.selectedLeader : ''}`}>
                      <div className={css.assistantPickAvatar} aria-hidden="true">
                        {assistant?.name.slice(0, 1).toLocaleUpperCase() ?? '?'}
                      </div>
                      <div className={css.selectedMemberCopy}>
                        <strong>{assistant?.name ?? '助手'}</strong>
                        <span>{assistant?.provider} / {assistant?.model}</span>
                      </div>
                      {leader
                        ? <span className={css.leaderBadge}>Leader</span>
                        : <button type="button" className={css.setLeaderButton} onClick={() => { setLeaderKey(member.key) }}>设为 Leader</button>}
                      <button
                        type="button"
                        className={css.removeDraftMember}
                        onClick={() => { removeMember(member.key) }}
                        aria-label={`移除 ${assistant?.name ?? '助手'}`}
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </div>
                  )
                })}
          </div>
          <div className={css.teamFields}>
            <Field label="团队名称">
              <input required value={name} onChange={event => { setName(event.target.value) }} placeholder="输入团队名称" className={css.input} />
            </Field>
            <Field label="Workspace">
              <div className={css.workspacePickerRow}>
                <select required value={workspaceId} onChange={event => { setWorkspaceId(event.target.value) }} className={css.input}>
                  <option value="">{workspaces.length === 0 ? '暂无 Workspace' : '请选择 Workspace'}</option>
                  {workspaces.map(item => <option key={item.id} value={item.id}>{item.title} — {item.path}</option>)}
                </select>
                <Button
                  variant="outline"
                  type="button"
                  disabled={pickingWorkspace || saving}
                  onClick={() => { void chooseWorkspace() }}
                  className={css.workspacePickButton}
                >
                  <IconFolderOpenOutline16 size={16} />
                  {pickingWorkspace ? '选择中…' : '选择文件夹'}
                </Button>
              </div>
            </Field>
            <label className={css.checkboxRow}>
              <input type="checkbox" checked={directMemberChat} onChange={event => { setDirectMemberChat(event.target.checked) }} />
              允许用户和普通成员直接通信
            </label>
          </div>
        </section>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
      <div className={css.teamBuilderActions}>
        <Button variant="outline" onClick={onCancel} disabled={saving}>取消</Button>
        <Button variant="primary" type="submit" disabled={saving || !canSubmit}>
          {saving ? '创建并启动中…' : '创建并启动'}
        </Button>
      </div>
    </form>
  )
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }): JSX.Element {
  return <label className={`${css.field} ${className}`}><span className={css.label}>{label}</span>{children}</label>
}

function Empty({ text, hint }: { text: string; hint?: string }): JSX.Element {
  return (
    <div className={css.empty}>
      <div className={css.emptyCopy}>
        <span className={css.emptyTitle}>{text}</span>
        {hint && <span className={css.emptyHint}>{hint}</span>}
      </div>
    </div>
  )
}
