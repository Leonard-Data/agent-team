import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
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

const floatingLauncherStorageKey = 'dsh-agent-team:floating-launcher-position'
const floatingLauncherMargin = 8
const floatingLauncherWidth = 42
const floatingLauncherExpandedWidth = 90
const floatingLauncherHeight = 42
const floatingLauncherDockThreshold = 8

type FloatingLauncherSide = 'left' | 'right'

interface FloatingLauncherPosition {
  x: number
  y: number
}

interface FloatingLauncherPlacement {
  position: FloatingLauncherPosition
  side: FloatingLauncherSide
}

function defaultFloatingLauncherPlacement(): FloatingLauncherPlacement {
  return {
    position: {
      x: 16,
      y: Math.round(window.innerHeight * 0.62),
    },
    side: 'left',
  }
}

function clampFloatingLauncherPosition(position: FloatingLauncherPosition): FloatingLauncherPosition {
  return {
    x: Math.min(
      Math.max(floatingLauncherMargin, position.x),
      Math.max(floatingLauncherMargin, window.innerWidth - floatingLauncherWidth - floatingLauncherMargin),
    ),
    y: Math.min(
      Math.max(floatingLauncherMargin, position.y),
      Math.max(floatingLauncherMargin, window.innerHeight - floatingLauncherHeight - floatingLauncherMargin),
    ),
  }
}

function clampFloatingLauncherDragPosition(position: FloatingLauncherPosition): FloatingLauncherPosition {
  return {
    x: Math.min(
      Math.max(floatingLauncherMargin, position.x),
      Math.max(floatingLauncherMargin, window.innerWidth - floatingLauncherExpandedWidth - floatingLauncherMargin),
    ),
    y: Math.min(
      Math.max(floatingLauncherMargin, position.y),
      Math.max(floatingLauncherMargin, window.innerHeight - floatingLauncherHeight - floatingLauncherMargin),
    ),
  }
}

function floatingLauncherSide(position: FloatingLauncherPosition): FloatingLauncherSide {
  return position.x + floatingLauncherWidth / 2 > window.innerWidth / 2 ? 'right' : 'left'
}

function isFloatingLauncherDocked(position: FloatingLauncherPosition): boolean {
  const maxX = Math.max(
    floatingLauncherMargin,
    window.innerWidth - floatingLauncherWidth - floatingLauncherMargin,
  )
  return position.x <= floatingLauncherMargin + floatingLauncherDockThreshold
    || position.x >= maxX - floatingLauncherDockThreshold
}

function readFloatingLauncherPlacement(): FloatingLauncherPlacement | undefined {
  try {
    const stored = window.localStorage.getItem(floatingLauncherStorageKey)
    if (stored === null) return undefined
    const parsed = JSON.parse(stored) as Partial<FloatingLauncherPosition> & { side?: unknown }
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return undefined
    const position = { x: parsed.x as number, y: parsed.y as number }
    return {
      position,
      side: parsed.side === 'left' || parsed.side === 'right'
        ? parsed.side
        : floatingLauncherSide(position),
    }
  } catch {
    return undefined
  }
}

function storeFloatingLauncherPlacement(placement: FloatingLauncherPlacement): void {
  try {
    window.localStorage.setItem(floatingLauncherStorageKey, JSON.stringify({
      ...placement.position,
      side: placement.side,
    }))
  } catch {
    // Storage can be unavailable in restricted WebViews; dragging still works for the current session.
  }
}

function FloatingTeamLauncher({ hasExecutingTeam }: { hasExecutingTeam: boolean }): JSX.Element {
  const [placement, setPlacement] = useState<FloatingLauncherPlacement>()
  const [dragPosition, setDragPosition] = useState<FloatingLauncherPosition>()
  const [dragging, setDragging] = useState(false)
  const [dockSettled, setDockSettled] = useState(false)
  const [tooltipSuppressed, setTooltipSuppressed] = useState(false)
  const dragRef = useRef<{
    pointerId: number
    pointerX: number
    pointerY: number
    startX: number
    startY: number
    position: FloatingLauncherPosition
    moved: boolean
  }>()
  const suppressClickRef = useRef(false)

  useEffect(() => {
    const stored = readFloatingLauncherPlacement() ?? defaultFloatingLauncherPlacement()
    const initialPosition = clampFloatingLauncherPosition(stored.position)
    setPlacement({
      position: initialPosition,
      side: isFloatingLauncherDocked(initialPosition)
        ? floatingLauncherSide(initialPosition)
        : stored.side,
    })
    const handleResize = (): void => {
      setPlacement(current => {
        const fallback = current ?? defaultFloatingLauncherPlacement()
        const position = clampFloatingLauncherPosition(fallback.position)
        return {
          position,
          side: isFloatingLauncherDocked(position)
            ? floatingLauncherSide(position)
            : fallback.side,
        }
      })
    }
    window.addEventListener('resize', handleResize)
    return () => { window.removeEventListener('resize', handleResize) }
  }, [])

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current
    if (drag === undefined || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (drag.moved) {
      const maxDragX = Math.max(
        floatingLauncherMargin,
        window.innerWidth - floatingLauncherExpandedWidth - floatingLauncherMargin,
      )
      const dockedLeft = drag.position.x <= floatingLauncherMargin + floatingLauncherDockThreshold
      const dockedRight = drag.position.x >= maxDragX - floatingLauncherDockThreshold
      const docked = dockedLeft || dockedRight
      const side: FloatingLauncherSide = dockedLeft
        ? 'left'
        : dockedRight
          ? 'right'
          : drag.position.x + floatingLauncherExpandedWidth / 2 > window.innerWidth / 2
            ? 'right'
            : 'left'
      const collapsedX = dockedLeft
        ? floatingLauncherMargin
        : dockedRight
          ? Math.max(
              floatingLauncherMargin,
              window.innerWidth - floatingLauncherWidth - floatingLauncherMargin,
            )
          : side === 'right'
            ? drag.position.x + floatingLauncherExpandedWidth - floatingLauncherWidth
            : drag.position.x
      const nextPlacement: FloatingLauncherPlacement = {
        position: clampFloatingLauncherPosition({ x: collapsedX, y: drag.position.y }),
        side,
      }
      setPlacement(nextPlacement)
      storeFloatingLauncherPlacement(nextPlacement)
      setDockSettled(docked)
    }
    suppressClickRef.current = drag.moved
    dragRef.current = undefined
    setDragPosition(undefined)
    setDragging(false)
  }

  const style: CSSProperties | undefined = dragPosition !== undefined
    ? { left: dragPosition.x, right: 'auto', top: dragPosition.y }
    : placement === undefined
    ? undefined
    : placement.side === 'right'
      ? {
          left: 'auto',
          right: Math.max(floatingLauncherMargin, window.innerWidth - placement.position.x - floatingLauncherWidth),
          top: placement.position.y,
        }
      : { left: placement.position.x, top: placement.position.y }

  return (
    <Tooltip
      label="Open team workbench"
      delayMs={400}
      disabled={dragging || tooltipSuppressed}
    >
      <button
        type="button"
        className={`${css.floatingTeamLauncher} ${dragging ? css.floatingTeamLauncherDragging : ''} ${dockSettled ? css.floatingTeamLauncherSettled : ''}`}
        style={style}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false
            return
          }
          openTeams()
        }}
        onPointerDown={event => {
          if (event.button !== 0) return
          setTooltipSuppressed(true)
          const currentPlacement = placement ?? defaultFloatingLauncherPlacement()
          const current = clampFloatingLauncherPosition(currentPlacement.position)
          const currentDragPosition = clampFloatingLauncherDragPosition({
            x: currentPlacement.side === 'right'
              ? current.x - (floatingLauncherExpandedWidth - floatingLauncherWidth)
              : current.x,
            y: current.y,
          })
          dragRef.current = {
            pointerId: event.pointerId,
            pointerX: event.clientX,
            pointerY: event.clientY,
            startX: currentDragPosition.x,
            startY: currentDragPosition.y,
            position: currentDragPosition,
            moved: false,
          }
          suppressClickRef.current = false
          setDockSettled(false)
          setDragPosition(currentDragPosition)
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={event => {
          const drag = dragRef.current
          if (drag === undefined || drag.pointerId !== event.pointerId) return
          const deltaX = event.clientX - drag.pointerX
          const deltaY = event.clientY - drag.pointerY
          if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return
          drag.moved = true
          drag.position = clampFloatingLauncherDragPosition({
            x: drag.startX + deltaX,
            y: drag.startY + deltaY,
          })
          setDragPosition(drag.position)
        }}
        onPointerUp={finishDrag}
        onPointerCancel={event => {
          finishDrag(event)
          suppressClickRef.current = false
          setDockSettled(false)
          setDragPosition(undefined)
        }}
        onPointerLeave={() => {
          if (!dragging) setDockSettled(false)
        }}
        onMouseLeave={() => {
          setTooltipSuppressed(false)
        }}
        aria-label={hasExecutingTeam ? 'Open team workbench; a team is running tasks' : 'Open team workbench'}
      >
        <span className={css.floatingTeamLauncherIcon}>
          <IconAgentPresetOutline16 size={18} />
          {hasExecutingTeam && <span className={css.floatingTeamLauncherState} aria-hidden="true" />}
        </span>
        <span className={css.floatingTeamLauncherLabel}>Team</span>
      </button>
    </Tooltip>
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
    return subscribeAgentTeam(() => { void load() }, () => { setError('Event connection lost; waiting to reconnect') })
  }, [active, load])

  return { catalog, assistants, teams, loading, error, load }
}

export function AgentTeamSettingsSection(_props: SettingsSectionOwnerProps): JSX.Element {
  const { catalog, assistants, loading, error, load } = useAgentTeamData(false)
  return (
    <section className={css.settingsSection}>
      <div className={css.settingsHeading}>
        <div>
          <h1 className={css.settingsTitle}>Agent Team</h1>
          <p className={css.settingsDescription}>Manage assistants, models, and permission settings that can be reused across teams.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => { void load() }} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      {error && <div role="alert" className={css.error}>{error}</div>}
      <AssistantPanel catalog={catalog} assistants={assistants} onChanged={load} />
    </section>
  )
}

export function AgentTeamOverlay({ pickWorkspace }: { pickWorkspace: () => Promise<WorkspaceChoice | null> }): JSX.Element | null {
  const { visible, createTeamRequest, selectedTeamId } = useAgentTeamUi()
  const { catalog, assistants, teams, error, load } = useAgentTeamData(true)
  const selectedTeam = teams.find(team => team.id === selectedTeamId)
  const hasExecutingTeam = teams.some(isTeamExecuting)
  const headerTitle = selectedTeam?.name ?? 'Agent Team'
  const headerSubtitle = selectedTeam === undefined
    ? 'Independent Agents sharing one Workspace'
    : `${Object.keys(selectedTeam.members).length} members · ${selectedTeam.workspacePath}`

  if (!visible) return <FloatingTeamLauncher hasExecutingTeam={hasExecutingTeam} />

  return (
    <section className={css.fullscreenWorkbench} aria-label="Agent Team workbench">
      <aside className={css.teamNavigator} aria-label="Team list">
        <div className={css.teamNavigatorHeader}>
          <button
            type="button"
            className={css.teamNavigatorTitle}
            onClick={openTeams}
            aria-label="View all teams"
            aria-current={selectedTeamId === undefined ? 'page' : undefined}
          >
            <IconAgentPresetOutline16 size={18} />
            <span>Teams</span>
          </button>
          <Tooltip label="Create team" delayMs={400}>
            <button type="button" className={css.teamNavigatorAdd} onClick={openTeamCreator} aria-label="Create team">
              <IconPlusOutline16 size={16} />
            </button>
          </Tooltip>
        </div>
        <div className={css.teamNavigatorList}>
          {teams.length === 0
            ? <div className={css.teamNavigatorEmpty}>No teams yet</div>
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
                    {executing && <span className={`${css.badge} ${css.badgeSuccess}`}>Tasks running</span>}
                  </span>
                </button>
              )
            })}
        </div>
        <div className={css.teamNavigatorFooter}>
          <span>{teams.length} teams</span>
        </div>
      </aside>

      <div className={css.fullscreenWorkbenchMain}>
        <header className={css.shellHeader}>
          <div className={css.headerCopy}>
            <div className={css.shellTitleRow}>
              <h1 className={css.title} title={headerTitle}>{headerTitle}</h1>
              {selectedTeam !== undefined && isTeamExecuting(selectedTeam) && (
                <span className={`${css.badge} ${css.badgeSuccess ?? ''}`}>
                  Tasks running
                </span>
              )}
            </div>
            <p className={css.subtitle} title={headerSubtitle}>{headerSubtitle}</p>
          </div>
          <button type="button" className={css.iconButton} onClick={closeAgentTeam} aria-label="Close workbench">
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
