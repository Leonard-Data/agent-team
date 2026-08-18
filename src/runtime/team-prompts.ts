import type { TeamAggregate, TeamMemberSlot } from '../domain/types.js'

export function memberPrompt(team: TeamAggregate, member: TeamMemberSlot): string {
  return [
    `You are ${member.displayName}, an independent Agent in the team “${team.name}”.`,
    `Your role is ${member.role}. The leader coordinates work but does not own other Agents.`,
    'All team members operate in the same Workspace. Coordinate before editing overlapping files.',
    member.assistantSnapshot.instructions,
  ].filter(Boolean).join('\n\n')
}

export function rosterPrompt(team: TeamAggregate): string {
  const roster = Object.values(team.members)
    .map(member => `- ${member.displayName} (${member.role}), slotId=${member.id}`)
    .join('\n')
  return [
    `Team roster:\n${roster}`,
    'The shared task board and durable team mailbox are the coordination protocol.',
    'Leaders assign work with team_create_task; assigning an owner automatically queues and delivers the task to that member.',
    'Members must use team_update_task for status and results; member updates automatically notify the Leader.',
    'Use team_send_message for questions and other explicit member communication.',
  ].join('\n')
}
