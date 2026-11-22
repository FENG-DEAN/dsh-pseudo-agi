/**
 * Panel host entry point for the bundled artifact.
 *
 * Only the host half lives here: the browser half is the bundle's `./client`
 * export, because the client module system reconciles a package by its Loader
 * entry name and reads that package's `dsh.client` declaration — which is this
 * package when the patch names a bundle subpath. See ./README.md.
 */
export * from '@pseudo-agi/panel'
