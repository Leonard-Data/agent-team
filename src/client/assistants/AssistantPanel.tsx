import type { FormEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconArchiveOutline20,
  IconPlusOutline16,
  IconSendOutline16,
  IconStopFill16,
  MarkdownText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantBuilderConversationListView,
  AssistantBuilderConversationSummary,
  AssistantBuilderConversationView,
  AssistantBuilderDraftView,
  AssistantView,
  CatalogView,
  McpCatalogView,
  SkillCatalogView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAssistantBuilderConversation } from '../api.js'
import css from '../AgentTeam.module.css'
import { shouldSubmitComposer } from '../keyboard.js'
import { PERMISSION_LABELS } from '../labels.js'
import { defaultReasoningLabel, useModelCapabilities } from '../model-reasoning.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { ConversationNodeView } from '../workbench/ConversationColumn.js'
import { PendingInteractionCard } from '../workbench/PendingInteractionCard.js'
import conversationCss from '../workbench/ConversationColumn.module.css'

const ASSISTANT_FORM_ID = 'agent-team-assistant-form'
const ASSISTANT_EDIT_FORM_ID = 'agent-team-assistant-edit-form'

export function AssistantPanel({
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
          <h2 className={css.sectionHeading}>Assistant templates <span className={css.count}>{assistants.length}</span></h2>
          <p className={css.sectionDescription}>Assistants are reusable templates and are not deleted when a team is dissolved.</p>
        </div>
        <div className={css.sectionHeaderActions}>
          <Button variant="primary" onClick={() => { setCreating(true) }}>Create manually</Button>
        </div>
      </div>
      <article className={css.assistantBuilderCard}>
        <div className={css.assistantBuilderAvatar} aria-hidden="true">AI</div>
        <div className={css.assistantBuilderCopy}>
          <span className={css.assistantBuilderEyebrow}>Built in · Default</span>
          <strong>Team Agent Assistant</strong>
          <p>Describe the role you need. It will collect the required settings, prepare long-term instructions, and create the assistant after confirmation.</p>
        </div>
        <Button variant="primary" onClick={() => { setBuilderOpen(true) }}>Start conversation</Button>
      </article>
      {assistants.length === 0
        ? <Empty text="No assistant templates yet" hint="Create an assistant, then add it to teams as a Leader or regular member." />
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
      <AnimatedModal
        open={builderOpen}
        onClose={() => { setBuilderOpen(false) }}
        title="Team Agent Assistant"
        closeLabel="Close"
        description="Design an assistant through conversation. Its complete configuration is saved to the template library after you confirm it."
        className={css.assistantBuilderDialog ?? ''}
        contentClassName={css.assistantBuilderDialogContent ?? ''}
      >
        {builderOpen && <AssistantBuilderConversation catalog={catalog} />}
      </AnimatedModal>
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="Create assistant"
        closeLabel="Close"
        description="Configure reusable model, permission, and long-term rules. Send specific tasks after the team starts."
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setCreating(false) }} disabled={assistantSaving}>Cancel</Button>
            <Button
              variant="primary"
              type="submit"
              form={ASSISTANT_FORM_ID}
              disabled={assistantSaving}
            >
              {assistantSaving ? 'Saving…' : 'Save assistant'}
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
      </AnimatedModal>
      <AnimatedModal
        open={editingAssistant !== undefined}
        onClose={() => { setEditingAssistant(undefined) }}
        title="Edit assistant"
        closeLabel="Close"
        description="Template updates affect only team members started later and do not change existing member snapshots."
        className={css.assistantDialog ?? ''}
        contentClassName={css.modalScrollContent ?? ''}
        footer={editingAssistant === undefined
          ? undefined
          : (
              <>
                <Button variant="outline" onClick={() => { setEditingAssistant(undefined) }} disabled={assistantSaving}>Cancel</Button>
                <Button
                  variant="primary"
                  type="submit"
                  form={ASSISTANT_EDIT_FORM_ID}
                  disabled={assistantSaving}
                >
                  {assistantSaving ? 'Saving…' : 'Save changes'}
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
      </AnimatedModal>
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
    const next = await callAgentTeam('assistant.builder.list')
    setHistory(next.items)
    return next
  }, [])

  const load = useCallback(async (sessionId?: string) => {
    try {
      if (sessionId !== undefined) {
        const next = await callAgentTeam('assistant.builder.get', { sessionId })
        setConversation(next)
        setDraft(undefined)
        drafting.current = false
        await loadHistory()
      } else {
        const nextHistory = await loadHistory()
        const latest = nextHistory.items[0]
        if (latest !== undefined) {
          const next = await callAgentTeam('assistant.builder.get', {
            sessionId: latest.sessionId,
          })
          setConversation(next)
          setDraft(undefined)
          drafting.current = false
        } else {
          const next = await callAgentTeam('assistant.builder.draft.get')
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
      setError('Live connection lost; waiting to reconnect')
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
  }, [conversation?.throughSeq, conversation?.nodes.length, conversation?.pendingInteractions.length])

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
        const next = await callAgentTeam('assistant.builder.start', {
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
        const next = await callAgentTeam('assistant.builder.draft.configure', {
          provider: selectedProvider,
          model: selectedModel,
        })
        setDraft(next)
      } else {
        const next = await callAgentTeam('assistant.builder.configure', {
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
      const next = await callAgentTeam('assistant.builder.draft.get')
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
  const pendingInteractions = conversation?.pendingInteractions ?? []
  const runtimeLabel = pendingInteractions.some(interaction => interaction.kind === 'approval')
    ? 'Awaiting approval'
    : pendingInteractions.length > 0
      ? 'Awaiting answer'
      : loading
        ? 'Starting…'
        : running
          ? 'Thinking'
          : 'Ready to chat'
  const providers = catalog?.providers ?? []
  const modelSelection = JSON.stringify([selectedProvider, selectedModel])
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
          <span>New conversation</span>
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
              <Tooltip label="Archive conversation" side="right" delayMs={400}>
                <button
                  type="button"
                  className={css.assistantBuilderHistoryArchive}
                  aria-label={`Archive conversation ${item.title}`}
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
          {!loading && history.length === 0 && <span className={css.assistantBuilderHistoryEmpty}>No conversation history</span>}
        </div>
      </aside>
      <div className={css.assistantBuilderMain}>
        <div className={css.assistantBuilderRuntime}>
        <span className={css.assistantBuilderRuntimeState}>
          <span className={`${css.statusDot} ${running ? css.statusRunning : css.statusIdle}`} aria-hidden="true" />
          <span>{runtimeLabel}</span>
        </span>
        <div className={css.assistantBuilderModelControls}>
          <select
            value={modelSelection}
            onChange={event => {
              const [provider, model] = JSON.parse(event.target.value) as [string, string]
              setSelectedProvider(provider)
              setSelectedModel(model)
              setModelSelectionDirty(true)
            }}
            className={css.assistantBuilderModelSelect}
            aria-label="Assistant model catalog"
            disabled={loading || running || applyingModel}
          >
            {providers.map(provider => (
              <optgroup key={provider.id} label={provider.name}>
                {(catalog?.models[provider.id] ?? []).map(model => (
                  <option
                    key={`${provider.id}/${model.id}`}
                    value={JSON.stringify([provider.id, model.id])}
                  >
                    {model.name === model.id ? model.id : `${model.name}（${model.id}）`}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            disabled={!modelChanged || !selectedProvider || !selectedModel || loading || running || applyingModel}
            onClick={() => { void applyModel() }}
          >
            {applyingModel ? 'Switching…' : 'Apply model'}
          </Button>
        </div>
        </div>
        <div ref={timeline} className={`${conversationCss.timeline} ${css.assistantBuilderTimeline}`}>
        {!loading && (draft !== undefined || conversation?.nodes.length === 0) && (
          <article className={`${conversationCss.messageNode} ${conversationCss.assistantMessage}`}>
            <div className={conversationCss.messageText}>
              <MarkdownText text="Hi, I'm the Team Agent Assistant. Tell me what kind of assistant you want to create and its main responsibilities. I'll ask for any missing settings." />
            </div>
          </article>
        )}
        {conversation?.nodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
        {pendingInteractions.map(interaction => (
          <PendingInteractionCard
            key={interaction.id}
            interaction={interaction}
            onRespond={async response => {
              if (conversation === undefined) return
              await callAgentTeam('assistant.builder.interaction.respond', {
                sessionId: conversation.sessionId,
                interactionId: interaction.id,
                response,
              })
            }}
          />
        ))}
        </div>
        <form
        className={`${conversationCss.composer} ${css.assistantBuilderComposer}`}
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
          placeholder={running ? 'The assistant is responding…' : 'For example: I need an assistant for React frontend development and code review'}
          disabled={loading || running}
          rows={3}
        />
        <div className={conversationCss.composerFooter}>
          <span className={css.muted}>Enter Send · Shift+Enter New line</span>
          <div className={conversationCss.composerActions}>
            {running && (
              <Tooltip label="Stop generating" side="top" delayMs={400}>
                <button type="button" className={conversationCss.composerIconButton} onClick={() => { void stop() }} aria-label="Stop generating">
                  <IconStopFill16 size={16} />
                </button>
              </Tooltip>
            )}
            <Tooltip label={sending ? 'Sending…' : 'Send message'} side="top" delayMs={400}>
              <button
                type="submit"
                className={conversationCss.composerIconButton}
                disabled={loading || running || sending || !selectedProvider || !selectedModel || content.trim().length === 0}
                aria-label={sending ? 'Sending' : 'Send message'}
              >
                <IconSendOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
        {error && <span className={conversationCss.composerError}>{error}</span>}
        </form>
      </div>
      </section>
      <AnimatedModal
        open={archiveCandidate !== undefined}
        onClose={() => {
          if (archivingSessionId === undefined) {
            setArchiveCandidate(undefined)
            setArchiveError(undefined)
          }
        }}
        title="Archive conversation"
        closeLabel="Close"
        description="After archiving, this conversation will no longer appear in the Team Agent Assistant history."
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
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={archiveCandidate === undefined || archivingSessionId !== undefined}
              onClick={() => { void archiveConversation() }}
            >
              {archivingSessionId !== undefined ? 'Archiving…' : 'Archive'}
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
              <p>The conversation content is not deleted; Harness retains the underlying session log.</p>
            </div>
            {archiveError && <div role="alert" className={css.inlineError}>{archiveError}</div>}
          </div>
        )}
      </AnimatedModal>
    </>
  )
}

function assistantBuilderStateLabel(state: AssistantBuilderConversationSummary['state']): string {
  if (state === 'completed') return 'Created'
  if (state === 'in_progress') return 'Configuring'
  return 'New conversation'
}

function formatConversationTime(value: string): string {
  return new Intl.DateTimeFormat('en-US', {
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
          aria-label={`Edit assistant ${assistant.name}`}
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
            Preset: {assistant.agentPresetId} · Permission: {PERMISSION_LABELS[assistant.permissionPresetId] ?? assistant.permissionPresetId} · Reasoning mode: {assistant.reasoningEffort ?? 'Model default'}
          </span>
          <span className={css.muted}>
            Skills: {assistant.skillAllowlist.length > 0 ? assistant.skillAllowlist.join(', ') : 'None selected'}
          </span>
          <span className={css.muted}>
            MCP: {assistant.mcpServers.length > 0 ? assistant.mcpServers.join(', ') : 'None selected'}
          </span>
          {assistant.description && <p className={css.description}>{assistant.description}</p>}
        </div>
        <div className={css.actions}>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={onEdit}>Edit</button>
          <button type="button" className={css.secondaryButton} disabled={busy} onClick={() => { void clone() }}>Duplicate</button>
          <button
            type="button"
            className={css.dangerButton}
            disabled={busy}
            onClick={() => {
              setError(undefined)
              setDeleteOpen(true)
            }}
          >
            Delete
          </button>
        </div>
        {error && !deleteOpen && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <AnimatedModal
        open={deleteOpen}
        onClose={() => {
          if (busy) return
          setDeleteOpen(false)
          setError(undefined)
        }}
        title="Delete assistant template"
        closeLabel="Close"
        description="This action cannot be undone."
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
              Cancel
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void remove() }}
            >
              {busy ? 'Deleting…' : 'Delete'}
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
            <p>Deleting the template does not affect teams or Workspaces. The system refuses deletion while a team member still references it.</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
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
  const [reasoningEffort, setReasoningEffort] = useState(assistant?.reasoningEffort ?? '')
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
  const modelCapabilities = useModelCapabilities(provider, modelChoice)

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
    if (modelCapabilities.loading || modelCapabilities.value === undefined) return
    const efforts = modelCapabilities.value.reasoning?.efforts ?? []
    setReasoningEffort(current => current && !efforts.some(effort => effort.id === current) ? '' : current)
  }, [modelCapabilities.loading, modelCapabilities.value])
  useEffect(() => {
    let active = true
    if (!agentPresetId) {
      setAvailableSkills([])
      setSelectedSkills([])
      return () => { active = false }
    }
    setSkillsLoading(true)
    setSkillsError(undefined)
    void callAgentTeam('skill.catalog', { agentPresetId })
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
    void callAgentTeam('mcp.catalog', { agentPresetId })
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
        ...(reasoningEffort ? { reasoningEffort } : {}),
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
        <Field label="Name"><input required value={name} onChange={event => { setName(event.target.value) }} className={css.input} /></Field>
        <Field label="Description"><input value={description} onChange={event => { setDescription(event.target.value) }} className={css.input} /></Field>
        <Field label="Provider">
          <select required value={provider} onChange={event => { setProvider(event.target.value) }} className={css.input}>
            <option value="">Select a provider</option>
            {providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label={`Model (${models.length} available)`}>
          <select required value={modelChoice} onChange={event => { setModelChoice(event.target.value) }} className={css.input}>
            <option value="" disabled>Select a model</option>
            {models.map(item => (
              <option key={item.id} value={item.id}>
                {item.name === item.id ? item.id : `${item.name}（${item.id}）`}
              </option>
            ))}
          </select>
        </Field>
        {modelCapabilities.value?.reasoning !== undefined && modelCapabilities.value.reasoning.efforts.length > 0 && (
          <Field label="Reasoning mode">
            <select
              value={reasoningEffort}
              onChange={event => { setReasoningEffort(event.target.value) }}
              className={css.input}
              aria-describedby={`${formId}-reasoning-hint`}
            >
              <option value="">{defaultReasoningLabel(modelCapabilities.value)}</option>
              {modelCapabilities.value.reasoning.efforts.map(effort => (
                <option key={effort.id} value={effort.id}>
                  {effort.name === effort.id ? effort.name : `${effort.name}（${effort.id}）`}
                </option>
              ))}
            </select>
            <span id={`${formId}-reasoning-hint`} className={css.hint}>Available levels are determined by the current Provider and model.</span>
          </Field>
        )}
        {modelCapabilities.error && <span className={conversationCss.composerError}>{modelCapabilities.error}</span>}
        <Field label="Agent Preset">
          <select required value={agentPresetId} onChange={event => { setAgentPresetId(event.target.value) }} className={css.input}>
            {presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label="Permission preset">
          <select required value={permissionPresetId} onChange={event => { setPermissionPresetId(event.target.value) }} className={css.input}>
            {permissions.map(item => (
              <option key={item.value} value={item.value}>
                {PERMISSION_LABELS[item.value] ?? item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Assistant instructions (optional)" className={css.fullWidth ?? ''}>
          <textarea
            value={instructions}
            onChange={event => { setInstructions(event.target.value) }}
            rows={4}
            placeholder="For example: Own frontend implementation; follow the existing code style; read relevant files before editing; report test results to the Leader when finished."
            className={css.input}
          />
          <span className={css.hint}>Saved with the template and added to the system prompt when a member starts. Do not enter a specific task here.</span>
        </Field>
        <Field
          label={`Available Skills (${selectedSkills.length} selected)`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="Select Skills available to the assistant">
            {skillsLoading && <span className={css.hint}>Loading Skills for this Preset…</span>}
            {!skillsLoading && skillsError && <span className={conversationCss.composerError}>{skillsError}</span>}
            {!skillsLoading && !skillsError && availableSkills.length === 0 && (
              <span className={css.hint}>This Agent Preset has no available Skills.</span>
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
                  <strong>{skill.name}{!skill.modelInvocable && skill.userInvocable ? ' · Slash command only' : ''}</strong>
                  <small>{skill.description}</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>Select only the Skills this assistant may need. Skill instructions are loaded at runtime when required by the task.</span>
        </Field>
        <Field
          label={`Available MCP Servers (${selectedMcpServers.length} selected)`}
          className={css.fullWidth ?? ''}
        >
          <div className={css.skillPicker} role="group" aria-label="Select MCP Servers available to the assistant">
            {mcpLoading && <span className={css.hint}>Loading MCP Servers for this Preset…</span>}
            {!mcpLoading && mcpError && <span className={conversationCss.composerError}>{mcpError}</span>}
            {!mcpLoading && !mcpError && availableMcpServers.length === 0 && (
              <span className={css.hint}>Harness has no MCP Servers configured for this Agent Preset.</span>
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
                  <small>{server.tools.length} tools</small>
                </span>
              </label>
            ))}
          </div>
          <span className={css.hint}>Harness Profile/Preset manages MCP connections and credentials; only tools from selected Servers are exposed to the assistant at runtime.</span>
        </Field>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
    </form>
  )
}
