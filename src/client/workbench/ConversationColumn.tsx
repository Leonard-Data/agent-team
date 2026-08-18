import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconSendOutline16,
  IconStopFill16,
  MarkdownText,
  MessageText,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CatalogView,
  ConversationNode,
  MemberConversationView,
  TeamView,
  WorkspaceUploadView,
} from '../../transport/contracts.js'
import { callAgentTeam, uploadAgentTeamFile } from '../api.js'
import css from './ConversationColumn.module.css'
import { mergeConversationNodes } from '../conversation-nodes.js'
import { insertWorkspaceFileMention } from '../file-mentions.js'
import { CrownIcon } from '../icons/CrownIcon.js'
import { shouldSubmitComposer } from '../keyboard.js'
import { memberStatusLabel, PERMISSION_LABELS } from '../labels.js'
import { PendingInteractionCard } from './PendingInteractionCard.js'

export function ConversationColumn({
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
  const pendingInteractions = conversation?.pendingInteractions ?? []
  const statusLabel = pendingInteractions.some(interaction => interaction.kind === 'approval')
    ? '等待审批'
    : pendingInteractions.length > 0
      ? '等待回答'
      : memberStatusLabel(conversation?.status ?? member.lastRuntimeState)

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
  }, [conversation?.throughSeq, pendingInteractions.length, pendingMessages.length])

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
      const delivered = await callAgentTeam('team.message.send', {
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
          <span className={css.columnStatus}>{statusLabel}</span>
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
        {visibleNodes.length === 0 && pendingInteractions.length === 0
          ? <div className={css.columnEmpty}>
            <span className={css.emptyAvatar}>{member.displayName.slice(0, 1).toUpperCase()}</span>
            <strong>{member.displayName}</strong>
            <span>{member.role === 'leader' ? '向 Leader 描述目标，由它组织团队协作。' : '等待 Leader 分配任务，或直接向该成员发送消息。'}</span>
          </div>
          : <>
            {visibleNodes.map(node => <ConversationNodeView key={node.id} node={node} />)}
            {pendingInteractions.map(interaction => (
              <PendingInteractionCard
                key={interaction.id}
                interaction={interaction}
                onRespond={async response => {
                  await callAgentTeam('team.interaction.respond', {
                    teamId: team.id,
                    slotId: member.id,
                    interactionId: interaction.id,
                    response,
                  })
                  await onSent()
                }}
              />
            ))}
          </>}
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
            <AssistantSkillsInfo skills={member.assistantSnapshot.skillAllowlist} />
            {conversation?.contextUsage !== undefined && (
              <ContextUsageMeter usage={conversation.contextUsage} />
            )}
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

function AssistantSkillsInfo({ skills }: { skills: readonly string[] }): JSX.Element {
  return (
    <div className={css.skillsInfo}>
      <button
        type="button"
        className={css.skillsInfoButton}
        aria-label={skills.length === 0 ? '当前助手未加载 Skills' : `查看当前助手加载的 ${skills.length} 个 Skills`}
      >
        <InfoIcon size={16} />
      </button>
      <div className={css.skillsInfoPopover} role="tooltip">
        <div className={css.skillsInfoHeading}>
          <strong>已加载 Skills</strong>
          <span>{skills.length} 个</span>
        </div>
        {skills.length === 0
          ? <span className={css.skillsInfoEmpty}>当前助手未加载 Skill</span>
          : (
            <ul className={css.skillsInfoList}>
              {skills.map(skill => <li key={skill}>{skill}</li>)}
            </ul>
          )}
      </div>
    </div>
  )
}

function InfoIcon({ size }: { size: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="5" r="1" fill="currentColor" />
      <path d="M8 7.5V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ContextUsageMeter({
  usage,
}: {
  usage: NonNullable<MemberConversationView['contextUsage']>
}): JSX.Element {
  const percent = usage.contextWindow === undefined
    ? undefined
    : Math.min(100, Math.round(usage.usedTokens / usage.contextWindow * 100))
  const pressureClass = percent !== undefined && percent >= 90
    ? css.contextUsageCritical
    : percent !== undefined && percent >= 75
      ? css.contextUsageWarning
      : ''
  const cacheHitPercent = usage.inputTokens === 0
    ? 0
    : Math.round(usage.cacheReadTokens / usage.inputTokens * 100)
  const details = [
    `输入 ${formatTokenCount(usage.inputTokens)}`,
    `输出 ${formatTokenCount(usage.outputTokens)}`,
    `缓存命中 ${cacheHitPercent}%`,
    ...(usage.cacheWriteTokens > 0 ? [`缓存写 ${formatTokenCount(usage.cacheWriteTokens)}`] : []),
    ...(usage.reasoningTokens > 0 ? [`思考 ${formatTokenCount(usage.reasoningTokens)}`] : []),
  ]
  return (
    <div className={`${css.contextUsage} ${pressureClass}`}>
      <button
        type="button"
        className={css.contextUsageButton}
        aria-label={percent === undefined
          ? `已使用约 ${usage.usedTokens} tokens，上下文窗口大小未知`
          : `上下文已使用约 ${usage.usedTokens} / ${usage.contextWindow} tokens，${percent}%`}
      >
        <svg className={css.contextUsageRing} viewBox="0 0 36 36" aria-hidden="true">
          <circle className={css.contextUsageRingTrack} cx="18" cy="18" r="14" />
          {percent !== undefined && (
            <circle
              className={css.contextUsageRingValue}
              cx="18"
              cy="18"
              r="14"
              pathLength="100"
              strokeDasharray={`${percent} 100`}
            />
          )}
        </svg>
      </button>
      <div className={css.contextUsagePopover} role="tooltip">
        <strong>已使用 {formatTokenCount(usage.usedTokens)} tokens</strong>
        <span>
          {usage.contextWindow === undefined
            ? '上下文窗口大小未知'
            : `上下文窗口 ${formatTokenCount(usage.contextWindow)} · 已用 ${percent}%`}
        </span>
        <span>{details.join(' · ')}</span>
      </div>
    </div>
  )
}

export function ConversationNodeView({ node }: { node: ConversationNode }): JSX.Element {
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

function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) {
    const scaled = value / 1_000
    return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}k`
  }
  const scaled = value / 1_000_000
  return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}m`
}

function prettyJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}
