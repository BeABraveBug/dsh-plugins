import type { SessionsServiceLike } from './host-api.ts'
import { collectMessages } from './messages.ts'
import { BACKGROUND_BUDGET, selectBackground } from './context.ts'

function latestSeq(entries: readonly unknown[]): number | undefined {
  let latest: number | undefined
  for (const entry of entries) {
    const record = entry as { type?: unknown; event?: { seq?: unknown } }
    if (record?.type !== 'event') continue
    const seq = record.event?.seq
    if (typeof seq === 'number' && (latest === undefined || seq > latest)) latest = seq
  }
  return latest
}

function within(entries: readonly unknown[], cutoff: number | undefined) {
  const messages = collectMessages(entries as never)
  return cutoff === undefined ? messages : messages.filter(message => message.seq === undefined || message.seq <= cutoff)
}

export interface ParentBackground {
  readonly text: string
  readonly fromSeq?: number
  readonly toSeq?: number
}

/** Read a bounded, frozen snapshot from the Parent session without creating one. */
export async function buildParentBackground(sessions: SessionsServiceLike, parentSessionId: string): Promise<ParentBackground> {
  const reference = sessions.retain(parentSessionId, { source: 'controllerOperation' })
  try {
    const binding = await reference.ready
    let window = binding.eventSource.getSnapshot()
    const cutoff = latestSeq(window.entries)
    let selection = selectBackground(within(window.entries, cutoff), BACKGROUND_BUDGET)
    let pages = 0
    while (window.hasMore && !selection.stoppedAtOverflow && selection.text.length < BACKGROUND_BUDGET) {
      if (pages >= 20) throw new Error('side-chat/background-history-limit')
      const loader = binding.session.loadOlder
      if (typeof loader !== 'function') throw new Error('side-chat/background-no-history-loader')
      const before = window.entries.length
      try {
        await loader.call(binding.session)
      } catch {
        throw new Error('side-chat/background-load-failed')
      }
      const next = binding.eventSource.getSnapshot()
      if (next.entries.length <= before) throw new Error('side-chat/background-load-stalled')
      window = next
      selection = selectBackground(within(window.entries, cutoff), BACKGROUND_BUDGET)
      pages += 1
    }
    if (window.hasMore && !selection.stoppedAtOverflow && selection.text.length < BACKGROUND_BUDGET) {
      throw new Error('side-chat/background-incomplete')
    }
    return {
      text: selection.text,
      ...(selection.fromSeq === undefined ? {} : { fromSeq: selection.fromSeq }),
      ...(selection.toSeq === undefined ? {} : { toSeq: selection.toSeq }),
    }
  } finally {
    reference.release()
  }
}
