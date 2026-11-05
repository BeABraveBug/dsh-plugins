const THEME_KEY = 'bookshelf.theme-snapshot.v1'

export interface ThemeSnapshotLite {
  readonly preference: 'light' | 'dark' | 'system'
  readonly colorScheme: 'light' | 'dark'
  readonly tokens: Record<string, string>
}

function readTheme(): ThemeSnapshotLite | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(THEME_KEY) ?? 'null') as Partial<ThemeSnapshotLite> | null
    if (parsed === null || (parsed.preference !== 'light' && parsed.preference !== 'dark' && parsed.preference !== 'system')) return null
    if (parsed.colorScheme !== 'light' && parsed.colorScheme !== 'dark') return null
    if (parsed.tokens === null || typeof parsed.tokens !== 'object' || Array.isArray(parsed.tokens)) return null
    const tokens: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed.tokens)) {
      if (typeof value === 'string' && name.startsWith('--dsw-')) tokens[name] = value
    }
    return { preference: parsed.preference, colorScheme: parsed.colorScheme, tokens }
  } catch { return null }
}

export function applyStoredTheme(): void {
  const theme = readTheme()
  const attribute = document.documentElement.getAttribute('data-theme-preference')
  const preference = theme?.preference ?? (attribute === 'light' || attribute === 'dark' || attribute === 'system' ? attribute : 'system')
  const scheme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference
  document.documentElement.style.colorScheme = scheme
  if (theme === null || theme.colorScheme !== scheme) return
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
    const source = document.documentElement.getAttribute('data-ds-theme-source')
    const preference = source === 'light' || source === 'dark' || source === 'system' ? source : 'system'
    try { localStorage.setItem(THEME_KEY, JSON.stringify({ preference, colorScheme: scheme, tokens })) } catch { /* storage unavailable */ }
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
