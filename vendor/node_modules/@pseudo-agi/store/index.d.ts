/** Name of the store directory when it lives inside the workspace. */
export declare const STORE_DIR: string
/** File name of the pointer that records the live root. */
export declare const STORE_POINTER: string
/** Pointer format version. */
export declare const STORE_VERSION: number
/** Layers the knowledge base owns. */
export declare const STORE_LAYERS: readonly string[]
/** Directory created under the user's home when no workspace root is configured. */
export declare const DEFAULT_WORKSPACE_DIR: string
/** Absolute default workspace root (`<home>/dsh-pseudo-agi`). */
export declare function defaultWorkspaceRoot(): string
/** Resolve the `workspaceRoot` setting; an empty value means the default. */
export declare function resolveWorkspaceRoot(configured: string | undefined): string

/** Where the knowledge base actually is, and why. */
export interface StoreLocation {
  /** Absolute workspace root the location was resolved against. */
  readonly workspaceRoot: string
  /** Absolute root of the live knowledge base. */
  readonly base: string
  /** What decided `base`: the pointer file or the configured default. */
  readonly source: 'pointer' | 'config'
  /** Absolute path of the pointer file, whether or not it exists. */
  readonly pointerPath: string
  /** Parsed pointer record, or null when there is no usable pointer. */
  readonly pointer: {
    readonly version?: number
    readonly root?: string
    readonly movedAt?: string
    readonly movedFrom?: string
    readonly copiedFiles?: number
    readonly copiedBytes?: number
  } | null
  /** Absolute path the configured default resolves to. */
  readonly fallback: string
  /** Why a pointer that exists was ignored; undefined when there was nothing to ignore. */
  readonly warning: string | undefined
}

/** What a store root holds. */
export interface StoreStats {
  readonly base: string
  readonly exists: boolean
  readonly files: number
  readonly bytes: number
  readonly layers: Record<string, number>
  readonly candidates: number
  readonly governanceFiles: number
  readonly workingDigest: boolean
}

/** Outcome of a relocation. */
export interface RelocationReport {
  readonly from: string
  readonly to: string
  readonly copied: { readonly files: number; readonly bytes: number }
  readonly verified: boolean
  readonly moved: boolean
  readonly pointerPath: string
  readonly restartRequired: boolean
}

/** Outcome of a rollback. */
export interface RollbackReport {
  readonly changed: boolean
  readonly removed: boolean
  readonly base: string
  readonly from: string
  readonly reason?: string
}

/** Whether `target` is `root` itself or lies inside it. */
export declare function isWithin(root: string, target: string): boolean
/** Absolute path of the pointer file for one workspace. */
export declare function pointerPath(workspaceRoot: string): string
/** Resolve the live store root: pointer file, then configured default, then `<workspaceRoot>/.pseudo-agi`. */
export declare function resolveStore(options: { workspaceRoot: string; storeRoot?: string }): StoreLocation
/** Map one configured path onto the live store. */
export declare function storePath(location: StoreLocation, candidate: string): string
/** Count what a store root holds. */
export declare function storeStats(location: StoreLocation): Promise<StoreStats>
/** Move the knowledge base: copy, verify, then re-point. */
export declare function relocateStore(
  location: StoreLocation,
  options: { to: string; move?: boolean; overwrite?: boolean },
): Promise<RelocationReport>
/** Re-point the store at an earlier location without touching the data. */
export declare function rollbackStore(location: StoreLocation, options?: { to?: string }): Promise<RollbackReport>
