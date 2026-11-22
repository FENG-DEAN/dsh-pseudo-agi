/**
 * Panel host entry point.
 *
 * Only the host half lives here: the browser half is this package's `./client`
 * export, because the client module system reconciles a package by its Loader
 * entry name and reads that package's `dsh.client` declaration — which is this
 * package when the patch names a bundle subpath.
 *
 * Re-exports the **vendored** copy by relative path. A profile that fetched this
 * package has no install step for its siblings, so nothing here may resolve a
 * package name that lives outside the bundle. See ../vendor/README.md.
 */
export * from '../vendor/node_modules/@pseudo-agi/panel/index.js'
