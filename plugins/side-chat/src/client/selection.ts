/**
 * Only a user or assistant message row is quotable. The host renders assistant
 * rows as `assistant-step...` (verified on 0.2.1-rc.5); turn process, failure,
 * and tail rows share the same node-key channel but are not message content.
 */
export function isQuotableNodeKey(key: string | null | undefined): boolean {
  if (key === null || key === undefined || key === '') return false
  const separator = key.indexOf(':')
  const kind = separator >= 0 ? key.slice(separator + 1) : key
  return kind.startsWith('input-message')
    || kind.startsWith('assistant-step')
    || kind.startsWith('agent-message')
}
