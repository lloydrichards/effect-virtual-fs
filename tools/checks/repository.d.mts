export interface RepositoryPolicy {
  readonly kind: "library" | "application" | "generated" | "configuration"
  readonly runtime: "mixed" | "bun" | "node" | "browser" | "none"
  readonly effects: true | { readonly reason: string }
  readonly documentation: "public" | { readonly reason: string }
  readonly tests: {
    readonly shared?: string
    readonly tooling?: ReadonlyArray<string>
    readonly runtime?: ReadonlyArray<string>
    readonly operator?: ReadonlyArray<string>
    readonly reason?: string
  }
  readonly allowedDependencies: ReadonlyArray<string>
}

export type ExportTarget = string | null | ReadonlyArray<ExportTarget> | { readonly [condition: string]: ExportTarget }

export interface WorkspaceManifest {
  readonly name: string
  readonly private?: boolean
  readonly exports?: ExportTarget
  readonly scripts?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

export interface DiscoveredWorkspace {
  readonly directory: string
  readonly manifest: WorkspaceManifest
  readonly policy?: RepositoryPolicy
}

export interface Workspace extends DiscoveredWorkspace {
  readonly policy: RepositoryPolicy
}

export interface PublicEntry {
  readonly subpath: string
  readonly source: string
}

export const root: string

export const policies: Readonly<Record<string, RepositoryPolicy>>

export const sharedTestProjects: ReadonlyArray<{ readonly directory: string; readonly name: string }>

export function discoverWorkspaces(directory?: string, registry?: typeof policies): Promise<Array<DiscoveredWorkspace>>
export function publicEntries(workspace: Pick<DiscoveredWorkspace, "directory" | "manifest">): Array<PublicEntry>
export function validateInventory(
  workspaces?: ReadonlyArray<DiscoveredWorkspace>,
  directory?: string,
  registry?: typeof policies
): Promise<Array<Workspace>>
