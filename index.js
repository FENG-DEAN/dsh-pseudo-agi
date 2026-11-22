/**
 * Package root of the bundled artifact — the **panel host half**.
 *
 * Why the root module is a plugin at all: the client module system identifies a
 * package's browser module by the Loader row's specifier, but only accepts the
 * bare two-segment name (`exactPackageSpecifier` in
 * `@deepseek-ai/dsh-client-modules`). A three-segment subpath such as
 * `@pseudo-agi/bundle/layers/panel` resolves to `undefined` and the row is
 * dropped from client composition entirely — the panel host loads, the sidebar
 * entry never does.
 *
 * So the patch mounts this file for the panel row (`name: '@pseudo-agi/bundle'`)
 * and the other four layers as `layers/*` subpaths, which the client system
 * ignores on purpose. See cordis.patch.yml.
 */
export * from './vendor/node_modules/@pseudo-agi/panel/index.js'
