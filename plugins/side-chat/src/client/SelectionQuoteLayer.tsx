import { useEffect, useState } from 'react'
import type { IndependentApi } from './independent-api.ts'
import type { Observable } from './host-api.ts'
import type { Translate } from './i18n.ts'
import { isQuotableNodeKey } from './selection.ts'

interface Candidate {
  readonly text: string
  readonly parentId: string
  readonly top: number
  readonly left: number
  readonly sourceNodeKey?: string
}

interface SelectionQuoteLayerProps {
  readonly t: Translate
  readonly api: IndependentApi
  readonly mounted: Observable<string | undefined>
  readonly openSideChat: () => void
}

const QUOTE_BUTTON_ID = 'side-chat-quote-button'

function elementOf(node: Node | null): Element | null {
  if (node === null) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

/**
 * Watches the main conversation for a confirmed text selection and offers one
 * action: add it as a pending quote to the Parent's active side chat. Nothing is
 * sent and no real Session is created here.
 */
export function SelectionQuoteLayer({ t, api, mounted, openSideChat }: SelectionQuoteLayerProps) {
  const [parentId, setParentId] = useState<string | undefined>(() => mounted.getSnapshot())
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = mounted.subscribe(() => setParentId(mounted.getSnapshot()))
    return unsubscribe
  }, [mounted])

  useEffect(() => {
    setCandidate(null)
    setNotice(null)
  }, [parentId])

  useEffect(() => {
    if (parentId === undefined) {
      setCandidate(null)
      return
    }
    const onMouseUp = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setCandidate(null)
        return
      }
      const range = selection.getRangeAt(0)
      const element = elementOf(range.commonAncestorContainer)
      if (element === null || element.closest('[data-composer-input], [data-lexical-editor], .side-chat-pane') !== null) {
        setCandidate(null)
        return
      }
      if (element.closest('[data-conversation-region]') === null) {
        setCandidate(null)
        return
      }
      const text = selection.toString().trim()
      if (text === '') return
      const rect = range.getBoundingClientRect()
      const node = element.closest('[data-chat-node-key]')
      const nodeKey = node?.getAttribute('data-chat-node-key') ?? undefined
      if (!isQuotableNodeKey(nodeKey)) {
        setCandidate(null)
        return
      }
      setNotice(null)
      setCandidate({
        text,
        parentId,
        top: Math.min(rect.bottom + 8, window.innerHeight - 48),
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 160)),
        ...(nodeKey === undefined ? {} : { sourceNodeKey: nodeKey }),
      })
    }
    const onSelectionChange = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.toString().trim() === '') setCandidate(null)
    }
    const onScroll = (): void => setCandidate(null)
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (target instanceof Element && target.closest(`[id="${QUOTE_BUTTON_ID}"]`) !== null) return
      setCandidate(null)
    }
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [parentId])

  if (candidate === null) return null

  const addQuote = (): void => {
    const quote = {
      id: `quote-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      text: candidate.text,
      sourceSessionId: candidate.parentId,
      ...(candidate.sourceNodeKey === undefined ? {} : { sourceNodeKey: candidate.sourceNodeKey }),
      createdAt: Date.now(),
    }
    void api.addQuoteToActive(candidate.parentId, quote).then(() => {
      try {
        openSideChat()
      } catch {
        // The panel may be unavailable while the layout is disposing; the quote is kept.
      }
      setCandidate(null)
    }).catch((cause: { code?: string }) => {
      setNotice(cause.code === 'side-chat/quote-too-many' ? t('quote.tooMany') : cause.code === 'side-chat/quote-too-long' ? t('quote.tooLong') : null)
    })
  }

  return (
    <div
      id={QUOTE_BUTTON_ID}
      className="side-chat-quote"
      style={{ top: candidate.top, left: candidate.left }}
    >
      <button type="button" className="side-chat-quote__button" onClick={addQuote}>
        {t('quote.ask')}
      </button>
      {notice === null ? null : <p className="side-chat-quote__notice">{notice}</p>}
    </div>
  )
}
