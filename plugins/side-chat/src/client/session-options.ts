import type { SessionListLike, WorkspaceListLike } from './host-api.ts'

function isInside(path: string, root: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * Create the side Session as a member of the Parent's Workspace. The Host accepts
 * either a Workspace or a bare cwd, never both; a bare cwd creates an ungrouped
 * session, so the Workspace wins whenever one can be resolved.
 */
export function createOptionsFor(
  sessions: SessionListLike | undefined,
  workspaces: WorkspaceListLike | undefined,
  parentSessionId: string,
): { workspaceId?: string; cwd?: string } {
  const items = workspaces?.items ?? []
  const member = items.find(workspace => workspace.sessionIds.includes(parentSessionId))
  if (member !== undefined) return { workspaceId: member.workspaceId }
  const cwd = sessions?.byId?.[parentSessionId]?.cwd
  if (typeof cwd === 'string' && cwd.length > 0) {
    const enclosing = items
      .filter(workspace => isInside(cwd, workspace.path))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (enclosing !== undefined) return { workspaceId: enclosing.workspaceId }
    return { cwd }
  }
  return {}
}
