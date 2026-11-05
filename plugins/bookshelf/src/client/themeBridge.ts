const THEME_KEY = 'bookshelf.theme-snapshot.v1'

export interface ThemeSnapshotLite {
  readonly colorScheme: 'light' | 'dark'
  readonly tokens: Record<string, string>
}

function readTheme(): ThemeSnapshotLite | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(THEME_KEY) ?? 'null') as ThemeSnapshotLite | null
    return parsed !== null && (parsed.colorScheme === 'light' || parsed.colorScheme === 'dark') && typeof parsed.tokens === 'object' ? parsed : null
  } catch { return null }
}

export function applyStoredTheme(): void {
  const theme = readTheme()
  if (theme === null) {
    document.documentElement.style.colorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    return
  }
  document.documentElement.style.colorScheme = theme.colorScheme
  for (const [name, value] of Object.entries(theme.tokens)) document.documentElement.style.setProperty(name, value)
}

/** Capture the resolved host theme and republish it for the standalone page. */
export function publishHostTheme(): () => void {
  const publish = () => {
    const root = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    const tokens: Record<string, string> = {}
    for (const source of [root, body]) {
      for (const name of Array.from(source)) {
        if (!name.startsWith('--dsw-')) continue
        const value = source.getPropertyValue(name).trim()
        if (value !== '') tokens[name] = value
      }
    }
    const scheme = root.colorScheme === 'dark' || document.body.classList.contains('dark') ? 'dark' : 'light'
    try { localStorage.setItem(THEME_KEY, JSON.stringify({ colorScheme: scheme, tokens })) } catch { /* storage unavailable */ }
  }
  publish()
  const observer = new MutationObserver(publish)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  const media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', publish)
  return () => { observer.disconnect(); media.removeEventListener('change', publish) }
}

export function subscribeStoredTheme(): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === THEME_KEY) applyStoredTheme() }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
