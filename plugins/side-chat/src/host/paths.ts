import { homedir } from 'node:os'
import { join } from 'node:path'

function resolveDshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured
}

/** Legacy JSON path; only used to locate the plugin data directory and clear it. */
export function defaultStorePath(): string {
  return join(resolveDshHome(), 'side-chat', 'state.json')
}
