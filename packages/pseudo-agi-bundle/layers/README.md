# Bundle layer entry points

One file per layer, each a re-export of the package that owns the implementation:

```js
export * from '@pseudo-agi/memory'
```

Why they exist: a plugin patch names a **module specifier**, and the loader resolves
that specifier from the *profile's* package scope (`import.meta.resolve` anchored at
`.cordis/resolve.mjs`). A profile that installed this artifact as one tarball has
`@pseudo-agi/bundle` in its `node_modules`, but not the six sibling packages — they
live inside the bundle's own `node_modules` because the bundle is self-contained.

So the patch points at `@pseudo-agi/bundle/layers/memory`, which resolves from the
profile, and the re-export then resolves `@pseudo-agi/memory` from *this* package's
directory, where the bundled copy sits. Same file works for a development install
(`link:`), because there the sibling packages resolve through the workspace.

Keep one file per layer instead of a single barrel: each patch row must stay
independently disableable.
