import type { Translate } from './i18n.ts'

/** Conversation-header action that opens the Side Chat tab for this Session. */
export function OpenSideChatButton({ t, open }: { t: Translate; open: () => void }) {
  return (
    <button
      type="button"
      className="side-chat-launcher"
      aria-label={t('panel.title')}
      title={t('panel.guide')}
      onClick={open}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2.5 4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H7l-3 2.5V10.5h-.5a1 1 0 0 1-1-1z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
