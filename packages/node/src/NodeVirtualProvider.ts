// Node requires native fs constants and promise methods at this boundary.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
/**
 * Direct Node 26.11.1 VirtualProvider binding. Construction never mounts a filesystem.
 * @since 0.1.0
 */
import { RootCallerOptions } from "@effect-vfs/core/Caller"
import * as Adapter from "@effect-vfs/core/SynchronousAdapter"
import { make as failure } from "@effect-vfs/core/VfsError"
import type { FsFailure, Volume } from "@effect-vfs/core/VirtualFileSystem"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { type BigIntStats, constants, type Stats } from "node:fs"
import { VirtualProvider } from "node:vfs"
import {
  dataOf,
  encoded,
  encodingOf,
  type EncodingOptions,
  Entry,
  flagsOf,
  integer,
  invoke,
  NodeError,
  ownerOf,
  pathOf,
  statsOf,
  textOf,
  timesOf
} from "./internal/conversions.js"
import { NodeFileHandle, type StatOptions, type Time } from "./internal/fileHandle.js"

/**
 * Provider policy, independent of the backing volume's other callers.
 * @since 0.1.0
 */
export const Options = Schema.Struct({
  readonly: Schema.optionalKey(Schema.Boolean),
  caller: Schema.optionalKey(RootCallerOptions)
})

/** @since 0.1.0 */
export type Options = typeof Options.Type

type DirectoryOptions = Exclude<EncodingOptions, string> & {
  readonly withFileTypes?: boolean
  readonly recursive?: boolean
}

type FileOptions = {
  readonly encoding?: BufferEncoding | "buffer" | null | undefined
  readonly flag?: string | number
  readonly mode?: number
}

type WholeFileOptions = BufferEncoding | FileOptions | null

const noFollow = (path: string) => ({ _tag: "Path" as const, path, followFinalSymlink: false })

/**
 * A provider over an existing synchronous volume. Node allocates numeric descriptors above this protocol.
 * Instances are constructed with bind and remain valid for its enclosing Effect scope.
 * @since 0.1.0
 */
export class Provider extends VirtualProvider {
  /** @internal */
  constructor(private readonly binding: Adapter.Binding, private readonly readOnly = false) {
    super()
  }
  override get readonly() {
    return this.readOnly
  }
  override get supportsSymlinks() {
    return true
  }
  override get supportsWatch() {
    return false
  }

  private mutate(syscall: string, path: string): void {
    if (this.readonly) throw new NodeError("EROFS", syscall, path)
  }

  openSync(input: string, flags: string | number = "r", mode = 0o666): NodeFileHandle {
    const path = pathOf(input, "open")
    const decoded = flagsOf(flags, mode, path)

    if (decoded.writable || decoded.options.create !== "never") this.mutate("open", path)
    let directory = decoded.directory

    if (decoded.directory || !decoded.writable && decoded.options.create === "never") {
      const info = invoke("open", path, () => this.binding.stat(decoded.noFollow ? noFollow(path) : path))

      if (decoded.noFollow && info.kind === "symlink") throw new NodeError("ELOOP", "open", path)

      if (decoded.directory && info.kind !== "directory") throw new NodeError("ENOTDIR", "open", path)
      directory = info.kind === "directory"
    }

    if (directory && (decoded.writable || decoded.options.create !== "never")) {
      throw new NodeError("EISDIR", "open", path)
    }

    return new NodeFileHandle(
      invoke("open", path, () => this.binding.open(path, decoded.options, decoded.noFollow, directory)),
      path,
      flags,
      mode,
      decoded,
      this.readonly
    )
  }
  async open(path: string, flags: string | number = "r", mode = 0o666) {
    return this.openSync(path, flags, mode)
  }

  statSync(input: string, options: { readonly bigint: true }): BigIntStats
  statSync(input: string, options?: { readonly bigint?: false | undefined }): Stats
  statSync(input: string, options?: StatOptions): Stats | BigIntStats
  statSync(input: string, options?: StatOptions) {
    const path = pathOf(input, "stat")

    return statsOf(invoke("stat", path, () => this.binding.stat(path)), options)
  }
  stat(path: string, options: { readonly bigint: true }): Promise<BigIntStats>
  stat(path: string, options?: { readonly bigint?: false | undefined }): Promise<Stats>
  stat(path: string, options?: StatOptions): Promise<Stats | BigIntStats>
  async stat(path: string, options?: StatOptions) {
    return this.statSync(path, options)
  }
  lstatSync(input: string, options: { readonly bigint: true }): BigIntStats
  lstatSync(input: string, options?: { readonly bigint?: false | undefined }): Stats
  lstatSync(input: string, options?: StatOptions): Stats | BigIntStats
  lstatSync(input: string, options?: StatOptions) {
    const path = pathOf(input, "lstat")

    return statsOf(invoke("lstat", path, () => this.binding.stat(noFollow(path))), options)
  }
  lstat(path: string, options: { readonly bigint: true }): Promise<BigIntStats>
  lstat(path: string, options?: { readonly bigint?: false | undefined }): Promise<Stats>
  lstat(path: string, options?: StatOptions): Promise<Stats | BigIntStats>
  async lstat(path: string, options?: StatOptions) {
    return this.lstatSync(path, options)
  }

  readdirSync(input: string, options?: DirectoryOptions | BufferEncoding) {
    const path = pathOf(input, "scandir")
    const settings = Predicate.isString(options) ? { encoding: options } : options
    encodingOf(settings)
    const results: Array<string | Buffer | Entry<string | Buffer>> = []
    const pending = [{ path, prefix: "" }]

    for (const current of pending) {
      const entries = invoke("scandir", current.path, () => this.binding.readDirectory(current.path))

      for (const entry of entries.value) {
        const name = textOf(entry.name, "scandir", current.path)
        const info = invoke("scandir", current.path, () => this.binding.stat(entry.reference))
        results.push(
          settings?.withFileTypes
            ? new Entry(encoded(entry.name, { encoding: settings?.encoding ?? "utf8" }), current.path, info.kind)
            : encoded(Buffer.from(current.prefix + name), { encoding: settings?.encoding ?? "utf8" })
        )

        if (settings?.recursive && info.kind === "directory") {
          pending.push({ path: `${current.path.replace(/\/$/, "")}/${name}`, prefix: `${current.prefix}${name}/` })
        }
      }
    }

    return results
  }
  async readdir(path: string, options?: DirectoryOptions | BufferEncoding) {
    return this.readdirSync(path, options)
  }
  mkdirSync(input: string, options?: { readonly mode?: number; readonly recursive?: boolean } | number): void {
    const path = pathOf(input, "mkdir")
    this.mutate("mkdir", path)
    const chosen = Predicate.isNumber(options) ? { mode: options } : options
    invoke("mkdir", path, () => this.binding.mkdir(path, chosen))
  }
  async mkdir(path: string, options?: { readonly mode?: number; readonly recursive?: boolean } | number) {
    this.mkdirSync(path, options)
  }
  rmdirSync(input: string): void {
    const path = pathOf(input, "rmdir")
    this.mutate("rmdir", path)
    invoke("rmdir", path, () => this.binding.rmdir(path))
  }
  async rmdir(path: string) {
    this.rmdirSync(path)
  }
  unlinkSync(input: string): void {
    const path = pathOf(input, "unlink")
    this.mutate("unlink", path)
    invoke("unlink", path, () => this.binding.unlink(path))
  }
  async unlink(path: string) {
    this.unlinkSync(path)
  }
  renameSync(from: string, to: string): void {
    const path = pathOf(from, "rename"), dest = pathOf(to, "rename")
    this.mutate("rename", path)
    invoke("rename", path, () => this.binding.rename(path, dest), dest)
  }
  async rename(from: string, to: string) {
    this.renameSync(from, to)
  }
  linkSync(from: string, to: string): void {
    const path = pathOf(from, "link"), dest = pathOf(to, "link")
    this.mutate("link", path)
    invoke("link", path, () => this.binding.link(noFollow(path), dest), dest)
  }
  async link(from: string, to: string) {
    this.linkSync(from, to)
  }
  symlinkSync(target: string, input: string, type?: string): void {
    const path = pathOf(input, "symlink")
    pathOf(target, "symlink")
    this.mutate("symlink", path)

    if (type !== undefined && type !== "file" && type !== "dir") throw new NodeError("ENOTSUP", "symlink", path)
    invoke("symlink", path, () => this.binding.symlink(target, path))
  }
  async symlink(target: string, path: string, type?: string) {
    this.symlinkSync(target, path, type)
  }
  readlinkSync(input: string, options?: EncodingOptions) {
    const path = pathOf(input, "readlink")
    const bytes = invoke("readlink", path, () => this.binding.readLink(path))
    textOf(bytes, "readlink", path)

    return encoded(bytes, Predicate.isString(options) ? options : { encoding: options?.encoding ?? "utf8" })
  }
  async readlink(path: string, options?: EncodingOptions) {
    return this.readlinkSync(path, options)
  }
  realpathSync(input: string, options?: EncodingOptions) {
    const path = pathOf(input, "realpath")
    const bytes = invoke("realpath", path, () => this.binding.realPath(path))
    textOf(bytes, "realpath", path)

    return encoded(bytes, Predicate.isString(options) ? options : { encoding: options?.encoding ?? "utf8" })
  }
  async realpath(path: string, options?: EncodingOptions) {
    return this.realpathSync(path, options)
  }
  accessSync(input: string, mode = constants.F_OK): void {
    const path = pathOf(input, "access")
    integer(mode, "access", 7)

    if ((mode & constants.W_OK) !== 0) this.mutate("access", path)
    const allowed = invoke("access", path, () => this.binding.access(path, mode))

    if ((allowed & mode) !== mode) throw new NodeError("EACCES", "access", path)
  }
  async access(path: string, mode = constants.F_OK) {
    this.accessSync(path, mode)
  }

  chmodSync(input: string, mode: number, follow = true): void {
    const path = pathOf(input, follow ? "chmod" : "lchmod")
    this.mutate(follow ? "chmod" : "lchmod", path)
    integer(mode, "chmod", 0o7777)
    invoke(follow ? "chmod" : "lchmod", path, () => this.binding.chmod(follow ? path : noFollow(path), mode))
  }
  async chmod(path: string, mode: number) {
    this.chmodSync(path, mode)
  }
  lchmodSync(path: string, mode: number): void {
    this.chmodSync(path, mode, false)
  }
  async lchmod(path: string, mode: number) {
    this.lchmodSync(path, mode)
  }
  chownSync(input: string, uid: number, gid: number, follow = true): void {
    const path = pathOf(input, follow ? "chown" : "lchown")
    this.mutate(follow ? "chown" : "lchown", path)
    invoke(
      follow ? "chown" : "lchown",
      path,
      () => this.binding.chown(follow ? path : noFollow(path), ownerOf(uid, gid, "chown"))
    )
  }
  async chown(path: string, uid: number, gid: number) {
    this.chownSync(path, uid, gid)
  }
  lchownSync(path: string, uid: number, gid: number): void {
    this.chownSync(path, uid, gid, false)
  }
  async lchown(path: string, uid: number, gid: number) {
    this.lchownSync(path, uid, gid)
  }
  utimesSync(input: string, atime: Time, mtime: Time, follow = true): void {
    const path = pathOf(input, follow ? "utimes" : "lutimes")
    this.mutate(follow ? "utimes" : "lutimes", path)
    invoke(
      follow ? "utimes" : "lutimes",
      path,
      () => this.binding.utimes(follow ? path : noFollow(path), timesOf(atime, mtime))
    )
  }
  async utimes(path: string, atime: Time, mtime: Time) {
    this.utimesSync(path, atime, mtime)
  }
  lutimesSync(path: string, atime: Time, mtime: Time): void {
    this.utimesSync(path, atime, mtime, false)
  }
  async lutimes(path: string, atime: Time, mtime: Time) {
    this.lutimesSync(path, atime, mtime)
  }

  // Derived whole-file methods validate input before open can create or truncate a file.
  readFileSync(path: string, options?: WholeFileOptions) {
    encodingOf(options)
    const handle = this.openSync(path, Predicate.isObject(options) ? options.flag ?? "r" : "r")

    try {
      return handle.readFileSync(options)
    } finally {
      handle.closeSync()
    }
  }
  async readFile(path: string, options?: WholeFileOptions) {
    return this.readFileSync(path, options)
  }
  writeFileSync(path: string, data: string | Uint8Array, options?: WholeFileOptions): void {
    const bytes = dataOf(data, options)

    const handle = this.openSync(
      path,
      Predicate.isObject(options) ? options.flag ?? "w" : "w",
      Predicate.isObject(options) ? options.mode : undefined
    )

    try {
      handle.writeFileSync(bytes)
    } finally {
      handle.closeSync()
    }
  }
  async writeFile(path: string, data: string | Uint8Array, options?: WholeFileOptions) {
    this.writeFileSync(path, data, options)
  }
  appendFileSync(path: string, data: string | Uint8Array, options?: WholeFileOptions): void {
    this.writeFileSync(path, data, {
      ...(Predicate.isObject(options) ? options : { encoding: options }),
      flag: Predicate.isObject(options) ? options.flag ?? "a" : "a"
    })
  }
  async appendFile(path: string, data: string | Uint8Array, options?: WholeFileOptions) {
    this.appendFileSync(path, data, options)
  }
  existsSync(path: string): boolean {
    try {
      this.statSync(path)

      return true
    } catch (error) {
      if (error instanceof NodeError) return false
      throw error
    }
  }
  async exists(path: string) {
    return this.existsSync(path)
  }
  copyFileSync(src: string, dest: string, mode = 0): void {
    integer(mode, "copyfile", constants.COPYFILE_EXCL)
    const source = pathOf(src, "copyfile")
    const destination = pathOf(dest, "copyfile")

    try {
      this.mutate("copyfile", destination)
      const bytes = this.readFileSync(source)
      this.writeFileSync(destination, bytes, { flag: (mode & constants.COPYFILE_EXCL) !== 0 ? "wx" : "w" })
    } catch (cause) {
      if (cause instanceof NodeError) throw new NodeError(cause.code, "copyfile", source, destination, cause)
      throw cause
    }
  }
  async copyFile(src: string, dest: string, mode = 0) {
    this.copyFileSync(src, dest, mode)
  }

  watch(): never {
    throw new NodeError("ENOSYS", "watch")
  }
  watchAsync(): never {
    throw new NodeError("ENOSYS", "watch")
  }
  watchFile(): never {
    throw new NodeError("ENOSYS", "watchFile")
  }
  unwatchFile(): never {
    throw new NodeError("ENOSYS", "unwatchFile")
  }
  statfsSync(): never {
    throw new NodeError("ENOSYS", "statfs")
  }
  async statfs(): Promise<never> {
    return this.statfsSync()
  }
}

/**
 * Binds a qualified volume for this scope. Does not mount or install global hooks.
 * @since 0.1.0
 */
export const bind = Effect.fnUntraced(
  function*(volume: Volume, options?: Options): Effect.fn.Return<Provider, FsFailure, Scope.Scope> {
    const chosen = yield* Schema.decodeEffect(Options, { onExcessProperty: "error" })(
      options === undefined ? {} : options
    ).pipe(
      Effect.mapError((cause) => failure({ code: "InvalidArgument", operation: "bind", field: "options", cause }))
    )

    return new Provider(yield* Adapter.bind(volume, chosen.caller), chosen.readonly)
  }
)
