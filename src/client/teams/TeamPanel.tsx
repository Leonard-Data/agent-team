import type { FormEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  IconChevronLeftOutline14,
  IconCloseOutline16,
  IconFolderOpenOutline16,
  IconPlusOutline16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AssistantView,
  CatalogView,
  TeamView,
  TeamWorkbenchView,
} from '../../transport/contracts.js'
import { callAgentTeam, subscribeAgentTeamConversation } from '../api.js'
import { AssistantPanel } from '../assistants/AssistantPanel.js'
import css from '../AgentTeam.module.css'
import { CrownIcon } from '../icons/CrownIcon.js'
import { memberStatusLabel, TASK_STATE_LABELS } from '../labels.js'
import {
  initialVisibleMemberSlots,
  reconcileVisibleMemberSlots,
  toggleVisibleMemberSlot,
} from '../member-visibility.js'
import { AnimatedModal, Empty, Field } from '../shared.js'
import { openTeam } from '../store.js'
import { isTeamExecuting } from '../team-status.js'
import type { WorkspaceChoice } from '../types.js'
import { ConversationColumn } from '../workbench/ConversationColumn.js'
import { WorkspacePanel } from '../workspace/WorkspacePanel.js'

export function TeamPanel({
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
  const [managingAssistants, setManagingAssistants] = useState(false)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const visibleTeams = selectedTeamId === undefined
    ? teams
    : teams.filter(team => team.id === selectedTeamId)

  useEffect(() => {
    if (createRequest > 0) {
      setManagingAssistants(false)
      setCreating(true)
    }
  }, [createRequest])

  useEffect(() => {
    if (selectedTeamId !== undefined) setManagingAssistants(false)
  }, [selectedTeamId])

  return (
    <section className={css.section}>
      {selectedTeam === undefined && <div className={css.sectionHeader}>
        <div>
          <h2 className={css.sectionHeading}>Teams <span className={css.count}>{teams.length}</span></h2>
          <p className={css.sectionDescription}>Choose a Leader and members to collaborate in the same Workspace.</p>
        </div>
        <div className={css.sectionHeaderActions}>
          <Button variant="outline" onClick={() => { setManagingAssistants(true) }}>
            Manage assistants
          </Button>
          <Button variant="primary" disabled={assistants.length === 0} onClick={() => { setCreating(true) }}>
            Create team
          </Button>
        </div>
      </div>}
      {selectedTeam === undefined
        ? visibleTeams.length === 0
          ? <Empty text="No teams yet" hint="Create assistants with Manage assistants, then choose a Leader and team members." />
          : <div className={css.cardList}>{visibleTeams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                catalog={catalog}
                assistants={assistants}
                pickWorkspace={pickWorkspace}
                onChanged={onChanged}
                onCloned={async teamId => {
                  openTeam(teamId)
                  await onChanged()
                }}
              />
            ))}</div>
        : <TeamWorkbench
          team={selectedTeam}
          catalog={catalog}
          assistants={assistants}
          permissionPresets={catalog?.permissionPresets ?? []}
          pickWorkspace={pickWorkspace}
          onChanged={onChanged}
        />}
      <AnimatedModal
        open={managingAssistants}
        onClose={() => { setManagingAssistants(false) }}
        title="Manage assistants"
        closeLabel="Close"
        description="Create and maintain assistant templates that can be reused across teams."
        className={css.assistantManagementDialog ?? ''}
        contentClassName={css.assistantManagementDialogContent ?? ''}
      >
        <div className={css.assistantManagementBody}>
          <AssistantPanel
            catalog={catalog}
            assistants={assistants}
            onChanged={onChanged}
          />
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={creating}
        onClose={() => { setCreating(false) }}
        title="Create team"
        closeLabel="Close"
        description="Bring multiple AI assistants together. Every team must have exactly one Leader."
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
      </AnimatedModal>
    </section>
  )
}

function TeamWorkbench({
  team,
  catalog,
  assistants,
  permissionPresets,
  pickWorkspace,
  onChanged,
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  permissionPresets: CatalogView['permissionPresets']
  pickWorkspace: () => Promise<WorkspaceChoice | null>
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
  const [workspaceVisible, setWorkspaceVisible] = useState(true)
  const [workspaceRefreshSignal, setWorkspaceRefreshSignal] = useState(0)
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>()
  const loadGeneration = useRef(0)
  const previousMemberIds = useRef(memberIds)

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    try {
      const next = await callAgentTeam('team.workbench.get', { id: team.id })
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
  }, () => { setError('Live connection lost; waiting to reconnect') }, () => {
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
      <div className={css.workbenchMainPane}>
        <div className={css.memberTabs} aria-label="Team members">
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
                    title={`Remove member ${member.displayName}`}
                    aria-label={`Remove member ${member.displayName}`}
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
          {!workspaceVisible && (
            <Button
              variant="ghost"
              size="sm"
              className={css.manageButton}
              onClick={() => { setWorkspaceVisible(true) }}
            >
              <IconChevronLeftOutline14 size={14} />
              Workspace
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className={css.manageButton}
            onClick={() => {
              setAddMemberOpen(true)
            }}
          >
            <IconPlusOutline16 size={14} />
            Add assistant
          </Button>
          <Button variant="ghost" size="sm" className={css.manageButton} onClick={() => { setManagementOpen(value => !value) }}>
            {managementOpen ? 'Close management' : 'Manage team'}
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
            aria-label="Close expanded conversation"
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
        </div>
      </div>
      {workspaceVisible && (
        <WorkspacePanel
          team={team}
          refreshSignal={workspaceRefreshSignal}
          onCollapse={() => { setWorkspaceVisible(false) }}
        />
      )}
      <AnimatedModal
        open={managementOpen}
        onClose={() => { setManagementOpen(false) }}
        title="Team management"
        description="Manage members, the Leader, context, and the team lifecycle."
        closeLabel="Close"
        className={css.managementDialog ?? ''}
        contentClassName={css.managementDialogContent ?? ''}
      >
        <div className={css.managementDialogBody}>
          <TeamCard
            team={team}
            catalog={catalog}
            assistants={assistants}
            pickWorkspace={pickWorkspace}
            onChanged={async () => { await onChanged(); await load() }}
            onCloned={async teamId => {
              setManagementOpen(false)
              openTeam(teamId)
              await onChanged()
            }}
            compact
          />
        </div>
      </AnimatedModal>
      <AddTeamMemberDialog
        open={addMemberOpen}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddMemberOpen(false) }}
        onChanged={async () => { await onChanged(); await load() }}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (memberActionBusy) return
          setMemberToRemove(undefined)
          setMemberActionError(undefined)
        }}
        title="Remove team member"
        closeLabel="Close"
        description="This member will stop participating in the current team."
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
              Cancel
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={memberActionBusy}
              onClick={() => { void removeMember() }}
            >
              {memberActionBusy ? 'Removing…' : 'Remove'}
            </button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>Remove "{memberToRemove?.displayName}"?</strong>
            <p>The member will stop participating in the team. Removal is blocked while they have unfinished tasks. The assistant template and session history are retained.</p>
          </div>
          {memberActionError && <div role="alert" className={css.inlineError}>{memberActionError}</div>}
        </div>
      </AnimatedModal>
    </div>
  )
}


function AddTeamMemberDialog({
  open,
  team,
  catalog,
  assistants,
  onClose,
  onChanged,
}: {
  open: boolean
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  onClose: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [addingAssistantId, setAddingAssistantId] = useState<string>()
  const [configuringAssistants, setConfiguringAssistants] = useState(false)
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
    setConfiguringAssistants(false)
    setError(undefined)
    onClose()
  }

  return (
    <>
      <AnimatedModal
        open={open}
        onClose={close}
        title="Add assistant"
        description={`Choose an assistant to join team "${team.name}". The same assistant can join more than once.`}
        closeLabel="Close"
        className={css.addMemberDialog ?? ''}
        contentClassName={css.addMemberDialogContent ?? ''}
      >
        <div className={css.addMemberDialogHeader}>
          <strong>Assistant list</strong>
          <div className={css.addMemberDialogHeaderActions}>
            <span>{assistants.length} assistants</span>
            <Button
              variant="outline"
              size="sm"
              disabled={addingAssistantId !== undefined}
              onClick={() => { setConfiguringAssistants(true) }}
            >
              Assistant settings
            </Button>
          </div>
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
                {addingAssistantId === assistant.id ? 'Adding…' : <IconPlusOutline16 size={14} />}
              </span>
            </button>
          ))}
          {assistants.length === 0 && <span className={css.addMemberEmpty}>No assistant templates are available</span>}
        </div>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
      </AnimatedModal>
      <AnimatedModal
        open={configuringAssistants}
        onClose={() => { setConfiguringAssistants(false) }}
        title="Assistant settings"
        closeLabel="Close"
        description="Create and maintain assistant templates that can be reused across teams."
        className={css.assistantManagementDialog ?? ''}
        contentClassName={css.assistantManagementDialogContent ?? ''}
      >
        <div className={css.assistantManagementBody}>
          <AssistantPanel
            catalog={catalog}
            assistants={assistants}
            onChanged={onChanged}
          />
        </div>
      </AnimatedModal>
    </>
  )
}

function CloneTeamDialog({
  open,
  team,
  catalog,
  pickWorkspace,
  onClose,
  onCreated,
}: {
  open: boolean
  team: TeamView
  catalog: CatalogView | undefined
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onClose: () => void
  onCreated: (teamId: string) => Promise<void>
}): JSX.Element {
  const catalogWorkspaces = catalog?.workspaces.filter(workspace => workspace.status === 'ok') ?? []
  const [name, setName] = useState(`${team.name} copy`)
  const [workspaceId, setWorkspaceId] = useState(team.workspaceId)
  const [pickedWorkspace, setPickedWorkspace] = useState<WorkspaceChoice>()
  const [saving, setSaving] = useState(false)
  const [pickingWorkspace, setPickingWorkspace] = useState(false)
  const [error, setError] = useState<string>()
  const members = Object.values(team.members)
  const workspaces = useMemo(() => {
    const items = [...catalogWorkspaces]
    const fallback: WorkspaceChoice = pickedWorkspace ?? {
      id: team.workspaceId,
      path: team.workspacePath,
      title: workspaceName(team.workspacePath),
    }
    if (!items.some(workspace => workspace.id === fallback.id)) {
      items.push({ ...fallback, status: 'ok' as const })
    }
    return items
  }, [catalogWorkspaces, pickedWorkspace, team.workspaceId, team.workspacePath])

  useEffect(() => {
    if (!open) return
    setName(`${team.name} copy`)
    setWorkspaceId(team.workspaceId)
    setPickedWorkspace(undefined)
    setSaving(false)
    setPickingWorkspace(false)
    setError(undefined)
  }, [open, team.id, team.name, team.workspaceId])

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

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!name.trim() || !workspaceId) return
    setSaving(true)
    try {
      const draft = await callAgentTeam('team.clone', {
        teamId: team.id,
        name,
        workspaceId,
      })
      await callAgentTeam('team.start', { id: draft.id }, draft.revision)
      setError(undefined)
      onClose()
      await onCreated(draft.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  function close(): void {
    if (saving || pickingWorkspace) return
    onClose()
  }

  return (
    <AnimatedModal
      open={open}
      onClose={close}
      title="Duplicate team"
      closeLabel="Close"
      description="Reuse the current team configuration and create a new session for every member."
      className={css.cloneTeamDialog ?? ''}
      contentClassName={css.cloneTeamDialogContent ?? ''}
    >
      <form className={css.cloneTeamForm} onSubmit={(event) => { void submit(event) }}>
        <div className={css.cloneTeamFields}>
          <Field label="Team name">
            <input
              required
              value={name}
              onChange={event => { setName(event.target.value) }}
              placeholder="Enter a team name"
              className={css.input}
              autoFocus
            />
          </Field>
          <Field label="Workspace">
            <div className={css.workspacePickerRow}>
              <select
                required
                value={workspaceId}
                onChange={event => { setWorkspaceId(event.target.value) }}
                className={css.input}
              >
                <option value="">{workspaces.length === 0 ? 'No Workspaces available' : 'Select a Workspace'}</option>
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
                {pickingWorkspace ? 'Selecting…' : 'Choose folder'}
              </Button>
            </div>
          </Field>
        </div>
        <section className={css.cloneTeamMembers} aria-label="Duplicated team members">
          <div className={css.cloneTeamSectionHeader}>
            <strong>Team members</strong>
            <span>{members.length} members</span>
          </div>
          <div className={css.cloneTeamMemberGrid}>
            {members.map(member => (
              <div key={member.id} className={`${css.cloneTeamMember} ${member.role === 'leader' ? css.cloneTeamLeader : ''}`}>
                <span className={css.cloneTeamAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
                <span className={css.cloneTeamMemberCopy}>
                  <strong title={member.displayName}>{member.displayName}</strong>
                  <span>{member.assistantSnapshot.provider} / {member.assistantSnapshot.model}</span>
                </span>
                <span className={css.cloneTeamRole}>{member.role === 'leader' ? 'Leader' : 'Member'}</span>
              </div>
            ))}
          </div>
        </section>
        <p className={css.cloneTeamNotice}>Tasks, conversation context, message history, and runtime state are not copied.</p>
        {error && <div role="alert" className={css.inlineError}>{error}</div>}
        <div className={css.cloneTeamActions}>
          <Button variant="outline" type="button" disabled={saving || pickingWorkspace} onClick={close}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={saving || pickingWorkspace || !name.trim() || !workspaceId}>
            {saving ? 'Duplicating and starting…' : 'Duplicate and start'}
          </Button>
        </div>
      </form>
    </AnimatedModal>
  )
}

function TeamCard({
  team,
  catalog,
  assistants,
  pickWorkspace,
  onChanged,
  onCloned,
  compact = false,
}: {
  team: TeamView
  catalog: CatalogView | undefined
  assistants: AssistantView[]
  pickWorkspace: () => Promise<WorkspaceChoice | null>
  onChanged: () => Promise<void>
  onCloned: (teamId: string) => Promise<void>
  compact?: boolean
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [addingMember, setAddingMember] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [dissolveOpen, setDissolveOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [memberToRemove, setMemberToRemove] = useState<{ slotId: string; displayName: string }>()
  const [error, setError] = useState<string>()
  const members = Object.values(team.members)
  const tasks = Object.values(team.tasks)
  const executing = isTeamExecuting(team)

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
        {executing && <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>Tasks running</span>}
      </header>

      <section className={css.teamMemberSection} aria-label="Team members">
        <div className={css.teamSectionHeader}>
          <strong>Team members</strong>
          <span className={css.teamSectionActions}>
            <span>{members.length} members</span>
            <button
              type="button"
              className={css.addMemberButton}
              disabled={busy}
              onClick={() => { setAddingMember(true) }}
            >
              <IconPlusOutline16 size={14} />
              Add assistant
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
                  {memberStatusLabel(member.lastRuntimeState)}
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
                    Set as Leader
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
                    Remove
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>
      <div className={`${css.contextResetPanel} ${css.cloneTeamPanel ?? ''}`}>
        <div className={css.contextResetCopy}>
          <strong>Duplicate team</strong>
          <span>Reuse the current members and settings with a new session for every member.</span>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError(undefined)
            setCloneOpen(true)
          }}
        >
          Duplicate team
        </Button>
      </div>
      {tasks.length > 0 && (
        <div className={css.taskList}>
          <strong className={css.taskTitle}>Task board</strong>
          {tasks.map(task => (
            <div key={task.id} className={css.memberRow}>
              <span>{task.title}</span>
              <span className={css.muted}>{TASK_STATE_LABELS[task.status] ?? task.status}{task.ownerSlotId ? ` · ${team.members[task.ownerSlotId]?.displayName ?? 'Removed member'}` : ''}</span>
            </div>
          ))}
        </div>
      )}
      {team.state !== 'deleting' && team.state !== 'delete_blocked' && (
        <div className={css.contextResetPanel}>
          <div className={css.contextResetCopy}>
            <strong>Clear tasks and context</strong>
            <span>Stop all members, clear the task board, and give every member a new session. Workspace files and team settings remain unchanged.</span>
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
            {busy ? 'Processing…' : 'Clear'}
          </button>
        </div>
      )}
      <div className={`${css.contextResetPanel} ${css.dissolvePanel}`}>
        <div className={css.contextResetCopy}>
          <strong>Dissolve team</strong>
          <span>Permanently delete the team, tasks, and team messages. Assistant templates and Workspace files remain; old session logs are not restored.</span>
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
          {team.state === 'deleting' ? 'Dissolving…' : team.state === 'delete_blocked' ? 'Retry dissolve' : 'Dissolve team'}
        </button>
      </div>
        {error && !dissolveOpen && !resetOpen && memberToRemove === undefined && <div role="alert" className={css.inlineError}>{error}</div>}
      </article>
      <AddTeamMemberDialog
        open={addingMember}
        team={team}
        catalog={catalog}
        assistants={assistants}
        onClose={() => { setAddingMember(false) }}
        onChanged={onChanged}
      />
      <CloneTeamDialog
        open={cloneOpen}
        team={team}
        catalog={catalog}
        pickWorkspace={pickWorkspace}
        onClose={() => { setCloneOpen(false) }}
        onCreated={onCloned}
      />
      <AnimatedModal
        open={memberToRemove !== undefined}
        onClose={() => {
          if (busy) return
          setMemberToRemove(undefined)
          setError(undefined)
        }}
        title="Remove team member"
        closeLabel="Close"
        description="This member will stop participating in the current team."
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
              Cancel
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void removeMember() }}
            >
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </>
        )}
      >
        <div className={css.memberRemoveConfirm}>
          <div className={css.memberRemoveIcon} aria-hidden="true">−</div>
          <div>
            <strong>Remove "{memberToRemove?.displayName}"?</strong>
            <p>The member will stop participating in the team. Removal is blocked while they have unfinished tasks. The assistant template and session history are retained.</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={resetOpen}
        onClose={() => {
          if (busy) return
          setResetOpen(false)
          setError(undefined)
        }}
        title="Clear tasks and context"
        closeLabel="Close"
        description="All members will receive fresh conversation context."
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
              Cancel
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void resetTeam() }}
            >
              {busy ? 'Clearing…' : 'Clear'}
            </button>
          </>
        )}
      >
        <div className={css.teamResetConfirm}>
          <div className={css.teamResetIcon} aria-hidden="true">↻</div>
          <div>
            <strong>Clear tasks and context for "{team.name}"?</strong>
            <p>All members will stop, the task board and pending messages will be cleared, and every member will receive a new session. Workspace files, team settings, and old session logs are retained.</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
      <AnimatedModal
        open={dissolveOpen}
        onClose={() => {
          if (busy) return
          setDissolveOpen(false)
          setError(undefined)
        }}
        title="Dissolve team"
        closeLabel="Close"
        description="This action cannot be undone."
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
              Cancel
            </Button>
            <button
              type="button"
              className={`${css.dangerButton} ${css.confirmDangerButton}`}
              disabled={busy}
              onClick={() => { void dissolve() }}
            >
              {busy ? 'Dissolving…' : 'Dissolve'}
            </button>
          </>
        )}
      >
        <div className={css.teamDissolveConfirm}>
          <div className={css.teamDissolveIcon} aria-hidden="true">!</div>
          <div>
            <strong>Dissolve "{team.name}"?</strong>
            <p>All members will stop, and the team's tasks, messages, and settings will be permanently deleted. Assistant templates and Workspace files are retained.</p>
          </div>
          {error && <div role="alert" className={css.inlineError}>{error}</div>}
        </div>
      </AnimatedModal>
    </>
  )
}

interface DraftMember {
  key: string
  assistantId: string
}

function workspaceName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  return normalized.split(/[/\\]/).at(-1) || 'Workspace'
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
      const draft = await callAgentTeam('team.createDraft', {
        name,
        workspaceId,
        directMemberChat,
        members: members.map(member => ({
          assistantId: member.assistantId,
          role: member.key === leaderKey ? 'leader' : 'member',
        })),
      })
      await callAgentTeam('team.start', { id: draft.id }, draft.revision)
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
            <strong>All assistants <span className={css.count}>{assistants.length}</span></strong>
          </div>
          <input
            type="search"
            value={query}
            onChange={event => { setQuery(event.target.value) }}
            placeholder="Search assistants, Providers, or models"
            aria-label="Search assistants"
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
                  aria-label={`Add ${assistant.name}`}
                >
                  <IconPlusOutline16 size={16} />
                </button>
              </div>
            ))}
            {filteredAssistants.length === 0 && <Empty text="No matching assistants" />}
          </div>
        </section>

        <section className={css.selectedMembers}>
          <div className={css.builderSectionHeading}>
            <div>
              <strong>Selected members: {members.length}</strong>
              <p>Choose team members and assign one Leader. The same assistant may be selected more than once.</p>
            </div>
            <span className={css.leaderLegend}>Leader</span>
          </div>
          <div className={css.selectedMemberList}>
            {members.length === 0
              ? (
                  <div className={css.memberEmpty}>
                    <strong>Select at least one assistant as the team Leader.</strong>
                    <span>Add members from the assistant list on the left.</span>
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
                        <strong>{assistant?.name ?? 'Assistant'}</strong>
                        <span>{assistant?.provider} / {assistant?.model}</span>
                      </div>
                      {leader
                        ? <span className={css.leaderBadge}>Leader</span>
                        : <button type="button" className={css.setLeaderButton} onClick={() => { setLeaderKey(member.key) }}>Set as Leader</button>}
                      <button
                        type="button"
                        className={css.removeDraftMember}
                        onClick={() => { removeMember(member.key) }}
                        aria-label={`Remove ${assistant?.name ?? 'Assistant'}`}
                      >
                        <IconCloseOutline16 size={14} />
                      </button>
                    </div>
                  )
                })}
          </div>
          <div className={css.teamFields}>
            <Field label="Team name">
              <input required value={name} onChange={event => { setName(event.target.value) }} placeholder="Enter a team name" className={css.input} />
            </Field>
            <Field label="Workspace">
              <div className={css.workspacePickerRow}>
                <select required value={workspaceId} onChange={event => { setWorkspaceId(event.target.value) }} className={css.input}>
                  <option value="">{workspaces.length === 0 ? 'No Workspaces available' : 'Select a Workspace'}</option>
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
                  {pickingWorkspace ? 'Selecting…' : 'Choose folder'}
                </Button>
              </div>
            </Field>
            <label className={css.checkboxRow}>
              <input type="checkbox" checked={directMemberChat} onChange={event => { setDirectMemberChat(event.target.checked) }} />
              Allow users to message regular members directly
            </label>
          </div>
        </section>
      </div>
      {error && <div role="alert" className={css.inlineError}>{error}</div>}
      <div className={css.teamBuilderActions}>
        <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving || !canSubmit}>
          {saving ? 'Creating and starting…' : 'Create and start'}
        </Button>
      </div>
    </form>
  )
}
