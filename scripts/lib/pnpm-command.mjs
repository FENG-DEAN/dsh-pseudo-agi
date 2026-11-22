/**
 * Where the pnpm that started this script lives.
 *
 * pnpm sets `npm_execpath` for every package script, so spawning that file with
 * the current Node binary runs the same pnpm — the one the caller used, with its
 * store and registry settings. Falling back to a bare `pnpm` would look for a
 * command on PATH, which is not there when the script is started as
 * `node scripts/<name>.mjs` (Windows then reports `spawnSync pnpm ENOENT`).
 */

/**
 * Resolve the pnpm entry point for a child process.
 * @returns {{command: string, args: string[]}} executable and its leading arguments.
 */
export function pnpmCommand() {
  const execpath = process.env.npm_execpath
  if (typeof execpath === 'string' && execpath.length > 0) {
    return { command: process.execPath, args: [execpath] }
  }
  console.error('pnpm not found in this process: `npm_execpath` is unset.')
  console.error('Run this script through its package script, e.g. `pnpm release-check`,')
  console.error('so it inherits the pnpm that started it.')
  process.exit(1)
}
