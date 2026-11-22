// The bundle is a distribution unit, not a plugin: it carries no runtime code.
// Its whole job is to declare `dsh.bundle.patch` in package.json and ship the
// cordis.patch.yml that the loader applies. This entry point exists so the
// package resolves as a module when inspected.
export {}
