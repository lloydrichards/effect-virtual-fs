/**
 * Models and constructors for the experimental read-only NFSv4.1 server.
 *
 * The server exports one live `@effect-vfs/core` volume over NFSv4.1 so that
 * ordinary NFS clients can mount a virtual filesystem. It implements the
 * required read-only operation set and answers every other operation with
 * `NFS4ERR_NOTSUPP`.
 *
 * @since 0.1.0
 */
import { VirtualFileSystem as Vfs } from "@effect-vfs/core"
import * as ByteSize from "effect/ByteSize"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"
import type * as Scope from "effect/Scope"
import * as SocketServer from "effect/unstable/socket/SocketServer"
import { makeExport } from "./internal/export.js"
import { makeNfs4Handler } from "./internal/nfs4.js"
import type { CompoundCall } from "./internal/rpc.js"
import { startServer } from "./internal/server.js"

const PositiveSafeInteger = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

const Uint32 = Schema.Finite.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(0xffff_ffff)
)

const PositiveUint32 = Uint32.check(Schema.isGreaterThanOrEqualTo(1))

const PositiveByteSize = Schema.ByteSize.check(
  Schema.makeFilter((size) => size > 0n ? undefined : "must be at least 1 byte"),
  Schema.makeFilter((size) => size <= 0xffff_ffffn ? undefined : "must be at most 4294967295 bytes")
)

const FragmentByteSize = PositiveByteSize.check(
  Schema.makeFilter((size) => size <= 0x7fff_ffffn ? undefined : "must be at most 2147483647 bytes")
)

const NameByteSize = PositiveByteSize.check(
  Schema.makeFilter((size) => size <= 255n ? undefined : "must be at most 255 bytes")
)

/**
 * Schema for a literal IPv4 or IPv6 loopback address.
 *
 * @category schemas
 * @since 0.1.0
 */
export const LoopbackHost = Schema.Literals(["127.0.0.1", "::1"])

/**
 * A literal IPv4 or IPv6 loopback address.
 *
 * @category models
 * @since 0.1.0
 */
export type LoopbackHost = typeof LoopbackHost.Type

/**
 * Schema for a TCP port, including `0` for an ephemeral port.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Port = Uint32.check(Schema.isLessThanOrEqualTo(65_535))

/**
 * A TCP port, including `0` for an ephemeral port.
 *
 * @category models
 * @since 0.1.0
 */
export type Port = typeof Port.Type

const NfsServerLimitsSchema = Schema.Struct({
  maxConnections: PositiveSafeInteger,
  maxFragmentBytes: FragmentByteSize,
  maxRecordBytes: PositiveByteSize,
  maxFragmentsPerRecord: PositiveSafeInteger,
  maxOpaqueBytes: PositiveByteSize,
  maxStringBytes: PositiveByteSize,
  maxArrayElements: PositiveSafeInteger,
  maxAuthBytes: PositiveByteSize,
  maxMachineNameBytes: PositiveByteSize,
  maxSupplementaryGroups: PositiveSafeInteger,
  maxCompoundBytes: PositiveByteSize,
  maxOperations: PositiveSafeInteger,
  maxBitmapWords: PositiveSafeInteger,
  maxClients: PositiveSafeInteger,
  maxIdentities: PositiveSafeInteger,
  maxPendingClientReplacements: PositiveSafeInteger,
  maxSessions: PositiveSafeInteger,
  maxSlotsPerSession: PositiveSafeInteger,
  maxReplayBytes: PositiveByteSize,
  maxOpens: PositiveSafeInteger,
  maxLockOwners: PositiveSafeInteger,
  maxLocks: PositiveSafeInteger,
  maxOwnerBytes: PositiveByteSize,
  maxReadBytes: PositiveByteSize,
  maxWriteBytes: PositiveByteSize,
  maxReaddirEntries: PositiveSafeInteger,
  maxReaddirReplyBytes: PositiveByteSize,
  maxNameBytes: NameByteSize,
  maxFilehandles: PositiveSafeInteger
})

/**
 * Every resource bound enforced by the preview server.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerLimits = typeof NfsServerLimitsSchema.Type

const makeNfsServerLimits = (limits: NfsServerLimits): NfsServerLimits => Object.freeze({ ...limits })

const constrained = makeNfsServerLimits({
  maxConnections: 4,
  maxFragmentBytes: ByteSize.kibibytes(64),
  maxRecordBytes: ByteSize.kibibytes(128),
  maxFragmentsPerRecord: 8,
  maxOpaqueBytes: ByteSize.kibibytes(64),
  maxStringBytes: ByteSize.kibibytes(4),
  maxArrayElements: 64,
  maxAuthBytes: ByteSize.bytes(400),
  maxMachineNameBytes: ByteSize.bytes(255),
  maxSupplementaryGroups: 16,
  maxCompoundBytes: ByteSize.kibibytes(128),
  maxOperations: 16,
  maxBitmapWords: 4,
  maxClients: 8,
  maxIdentities: 8,
  maxPendingClientReplacements: 1,
  maxSessions: 8,
  maxSlotsPerSession: 4,
  maxReplayBytes: ByteSize.kibibytes(256),
  maxOpens: 64,
  maxLockOwners: 64,
  maxLocks: 256,
  maxOwnerBytes: ByteSize.bytes(256),
  maxReadBytes: ByteSize.kibibytes(64),
  maxWriteBytes: ByteSize.kibibytes(64),
  maxReaddirEntries: 64,
  maxReaddirReplyBytes: ByteSize.kibibytes(64),
  maxNameBytes: ByteSize.bytes(255),
  maxFilehandles: 512
})

const defaultLimits = makeNfsServerLimits({
  maxConnections: 16,
  maxFragmentBytes: ByteSize.mebibytes(1),
  maxRecordBytes: ByteSize.mebibytes(1),
  maxFragmentsPerRecord: 64,
  maxOpaqueBytes: ByteSize.mebibytes(1),
  maxStringBytes: ByteSize.kibibytes(4),
  maxArrayElements: 1_024,
  maxAuthBytes: ByteSize.bytes(400),
  maxMachineNameBytes: ByteSize.bytes(255),
  maxSupplementaryGroups: 32,
  maxCompoundBytes: ByteSize.mebibytes(1),
  maxOperations: 64,
  maxBitmapWords: 4,
  maxClients: 16,
  maxIdentities: 64,
  maxPendingClientReplacements: 1,
  maxSessions: 16,
  maxSlotsPerSession: 16,
  maxReplayBytes: ByteSize.mebibytes(4),
  maxOpens: 1_024,
  maxLockOwners: 1_024,
  maxLocks: 4_096,
  maxOwnerBytes: ByteSize.kibibytes(1),
  maxReadBytes: ByteSize.mebibytes(1),
  maxWriteBytes: ByteSize.mebibytes(1),
  maxReaddirEntries: 1_024,
  maxReaddirReplyBytes: ByteSize.mebibytes(1),
  maxNameBytes: ByteSize.bytes(255),
  maxFilehandles: 8_192
})

/**
 * Schema for every resource bound enforced by the preview server, with frozen presets.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NfsServerLimits = Object.assign(NfsServerLimitsSchema, {
  constrained,
  default: defaultLimits
})

/**
 * Schema for selectively overriding the default NFS server resource policy.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NfsServerLimitOverrides = Schema.Struct({
  maxConnections: Schema.optionalKey(NfsServerLimits.fields.maxConnections),
  maxFragmentBytes: Schema.optionalKey(NfsServerLimits.fields.maxFragmentBytes),
  maxRecordBytes: Schema.optionalKey(NfsServerLimits.fields.maxRecordBytes),
  maxFragmentsPerRecord: Schema.optionalKey(
    NfsServerLimits.fields.maxFragmentsPerRecord
  ),
  maxOpaqueBytes: Schema.optionalKey(NfsServerLimits.fields.maxOpaqueBytes),
  maxStringBytes: Schema.optionalKey(NfsServerLimits.fields.maxStringBytes),
  maxArrayElements: Schema.optionalKey(NfsServerLimits.fields.maxArrayElements),
  maxAuthBytes: Schema.optionalKey(NfsServerLimits.fields.maxAuthBytes),
  maxMachineNameBytes: Schema.optionalKey(
    NfsServerLimits.fields.maxMachineNameBytes
  ),
  maxSupplementaryGroups: Schema.optionalKey(
    NfsServerLimits.fields.maxSupplementaryGroups
  ),
  maxCompoundBytes: Schema.optionalKey(NfsServerLimits.fields.maxCompoundBytes),
  maxOperations: Schema.optionalKey(NfsServerLimits.fields.maxOperations),
  maxBitmapWords: Schema.optionalKey(NfsServerLimits.fields.maxBitmapWords),
  maxClients: Schema.optionalKey(NfsServerLimits.fields.maxClients),
  maxIdentities: Schema.optionalKey(NfsServerLimits.fields.maxIdentities),
  maxPendingClientReplacements: Schema.optionalKey(
    NfsServerLimits.fields.maxPendingClientReplacements
  ),
  maxSessions: Schema.optionalKey(NfsServerLimits.fields.maxSessions),
  maxSlotsPerSession: Schema.optionalKey(
    NfsServerLimits.fields.maxSlotsPerSession
  ),
  maxReplayBytes: Schema.optionalKey(NfsServerLimits.fields.maxReplayBytes),
  maxOpens: Schema.optionalKey(NfsServerLimits.fields.maxOpens),
  maxLockOwners: Schema.optionalKey(NfsServerLimits.fields.maxLockOwners),
  maxLocks: Schema.optionalKey(NfsServerLimits.fields.maxLocks),
  maxOwnerBytes: Schema.optionalKey(NfsServerLimits.fields.maxOwnerBytes),
  maxReadBytes: Schema.optionalKey(NfsServerLimits.fields.maxReadBytes),
  maxWriteBytes: Schema.optionalKey(NfsServerLimits.fields.maxWriteBytes),
  maxReaddirEntries: Schema.optionalKey(
    NfsServerLimits.fields.maxReaddirEntries
  ),
  maxReaddirReplyBytes: Schema.optionalKey(
    NfsServerLimits.fields.maxReaddirReplyBytes
  ),
  maxNameBytes: Schema.optionalKey(NfsServerLimits.fields.maxNameBytes),
  maxFilehandles: Schema.optionalKey(NfsServerLimits.fields.maxFilehandles)
})

/**
 * A selective override of the default NFS server resource policy.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerLimitOverrides = typeof NfsServerLimitOverrides.Type

/** Schema for configuration that can be validated without opening runtime capabilities. */
const NfsServerConfigSchema = Schema.Struct({
  leaseDurationSeconds: PositiveUint32,
  /** How long a backchannel callback waits for the client before the path is treated as down. */
  callbackTimeoutSeconds: PositiveUint32,
  limits: NfsServerLimits
})

/**
 * Complete server configuration.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerConfig = typeof NfsServerConfigSchema.Type

const defaultConfig: NfsServerConfig = Object.freeze({
  leaseDurationSeconds: 30,
  callbackTimeoutSeconds: 30,
  limits: NfsServerLimits.default
})

/**
 * Complete server configuration schema with a frozen default policy.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NfsServerConfig = Object.assign(NfsServerConfigSchema, {
  default: defaultConfig
})

/**
 * Optional configuration accepted when constructing an NFS server.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NfsServerConfigOverrides = Schema.Struct({
  leaseDurationSeconds: Schema.optionalKey(PositiveUint32),
  callbackTimeoutSeconds: Schema.optionalKey(PositiveUint32),
  limits: Schema.optionalKey(NfsServerLimitOverrides)
})

/**
 * Optional configuration accepted when constructing an NFS server.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerConfigOverrides = typeof NfsServerConfigOverrides.Type

/**
 * Schema for a bound loopback TCP address.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NfsServerTcpAddress = Schema.Struct({
  host: LoopbackHost,
  port: Port
})

/**
 * A bound loopback TCP address.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerTcpAddress = typeof NfsServerTcpAddress.Type

/** Schema for a TCP address that may be reachable beyond the local host. */
export const NfsServerNetworkTcpAddress = Schema.Struct({ host: Schema.NonEmptyString, port: Port })

/** A TCP address that may be reachable beyond the local host. */
export type NfsServerNetworkTcpAddress = typeof NfsServerNetworkTcpAddress.Type

/**
 * Schema for a bound UNIX-domain socket path. A filesystem socket is reachable only from the
 * same host, so it counts as a local address alongside loopback TCP.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NfsServerUnixAddress = Schema.Struct({
  path: Schema.NonEmptyString
})

/**
 * A bound UNIX-domain socket path.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerUnixAddress = typeof NfsServerUnixAddress.Type

/**
 * Schema for the bound server address: TCP or a UNIX-domain socket path.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NfsServerAddress = Schema.Union([NfsServerNetworkTcpAddress, NfsServerUnixAddress])

/**
 * The bound server address.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerAddress = typeof NfsServerAddress.Type

/**
 * Validated configuration paired with the live volume and caller capabilities.
 *
 * @category models
 * @since 0.1.0
 */
export type NfsServerLocalOptions = NfsServerConfigOverrides & {
  readonly volume: Vfs.Volume
  readonly caller: Vfs.Caller
  readonly policy?: never
  readonly peer?: never
  readonly allowNonLoopback?: never
  readonly acceptedFlavors?: never
}

/** Peer details from the transport; UNIX sockets do not expose a client IP or port. */
export type NfsPeer =
  | { readonly transport: "tcp"; readonly address: string; readonly port: number }
  | { readonly transport: "unix"; readonly address: null; readonly port: null; readonly path: string }

/** RPC identity claims. They grant no authority until the application policy maps them. */
export type NfsCredential =
  | { readonly flavor: "none" }
  | {
    readonly flavor: "sys"
    readonly uid: number
    readonly gid: number
    readonly groups: ReadonlyArray<number>
    readonly machineName: string
  }

/** A policy returns an identity for this volume or null to deny the request. */
export type NfsIdentityPolicy = (request: {
  readonly credential: NfsCredential
  readonly peer: NfsPeer
}) => NonNullable<Vfs.RootCallerOptions["identity"]> | null

export type NfsServerNetworkedOptions = NfsServerConfigOverrides & {
  readonly volume: Vfs.Volume
  readonly policy: NfsIdentityPolicy
  /** Evaluated in each accepted socket's context; null closes a connection without a trustworthy peer. */
  readonly peer: Effect.Effect<NfsPeer | null>
  /** Required when the supplied socket server binds outside loopback. */
  readonly allowNonLoopback?: true
  /** Flavors advertised by SECINFO; defaults to AUTH_SYS only. */
  readonly acceptedFlavors?: ReadonlyArray<"sys" | "none">
  readonly caller?: never
}

export type NfsServerOptions = NfsServerLocalOptions | NfsServerNetworkedOptions

/**
 * Raised when a server option fails validation before the server starts.
 *
 * The `option` field names the rejected configuration key.
 *
 * @category errors
 * @since 0.1.0
 */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly option: string
  readonly message: string
}> {}

/**
 * Raised when the NFS server cannot start or cannot continue listening.
 *
 * @category errors
 * @since 0.1.0
 */
export class NfsServerError extends Data.TaggedError("NfsServerError")<{
  readonly cause: unknown
}> {
  override get message(): string {
    return "The NFS server could not start or continue listening"
  }
}

const configurationError = (
  option: string,
  message: string
): ConfigurationError => new ConfigurationError({ option, message })

const configurationPath = (
  issue: SchemaIssue.Issue
): ReadonlyArray<PropertyKey> => {
  if (Predicate.isTagged(issue, "Pointer")) {
    return [...issue.path, ...configurationPath(issue.issue)]
  }

  if (Predicate.isTagged(issue, "Composite") || Predicate.isTagged(issue, "AnyOf")) {
    return issue.issues.length === 0 ? [] : configurationPath(issue.issues[0])
  }

  if (Predicate.isTagged(issue, "Filter") || Predicate.isTagged(issue, "Encoding")) {
    return configurationPath(issue.issue)
  }

  return []
}

const configurationField = (issue: SchemaIssue.Issue): string => {
  const path = configurationPath(issue)

  return path.length === 0 ? "options" : path.map(String).join(".")
}

const decodeConfig = (
  options: NfsServerOptions
): Effect.Effect<NfsServerConfig, ConfigurationError> =>
  Effect.suspend(() => {
    const {
      caller: _caller,
      volume: _volume,
      policy: _policy,
      peer: _peer,
      allowNonLoopback: _allowNonLoopback,
      acceptedFlavors: _acceptedFlavors,
      ...supplied
    } = options

    const suppliedLimits: unknown = supplied.limits

    const limits = suppliedLimits === undefined
      ? NfsServerLimits.default
      : Predicate.isObject(suppliedLimits)
      ? { ...NfsServerLimits.default, ...suppliedLimits }
      : suppliedLimits

    return Schema.decodeUnknownResult(NfsServerConfig, { onExcessProperty: "error" })({
      ...supplied,
      leaseDurationSeconds: supplied.leaseDurationSeconds === undefined
        ? NfsServerConfig.default.leaseDurationSeconds
        : supplied.leaseDurationSeconds,
      callbackTimeoutSeconds: supplied.callbackTimeoutSeconds === undefined
        ? NfsServerConfig.default.callbackTimeoutSeconds
        : supplied.callbackTimeoutSeconds,
      limits
    }).pipe(
      Result.mapError((error) => {
        const option = configurationField(error.issue)

        return configurationError(
          option,
          `Invalid NFS server configuration at ${option}`
        )
      }),
      Result.match({ onFailure: Effect.fail, onSuccess: Effect.succeed })
    )
  })

const make = (
  options: NfsServerOptions
): Effect.Effect<
  NfsServer["Service"],
  ConfigurationError | NfsServerError,
  Scope.Scope | SocketServer.SocketServer | Crypto.Crypto
> =>
  Effect.gen(function*() {
    const config = yield* decodeConfig(options)
    const limits = config.limits
    const policy = options.policy
    const networked = policy !== undefined

    if (networked && !Predicate.isFunction(policy)) {
      return yield* configurationError("policy", "policy must be a function")
    }

    if (networked === (options.caller !== undefined)) {
      return yield* configurationError("options", "supply either caller or policy")
    }

    if (networked && !Effect.isEffect(options.peer)) {
      return yield* configurationError("peer", "networked mode requires a peer resolver Effect")
    }

    if (
      !networked && (
        options.peer !== undefined || options.allowNonLoopback !== undefined || options.acceptedFlavors !== undefined
      )
    ) {
      return yield* configurationError("options", "networked options require a policy")
    }

    if (options.allowNonLoopback !== undefined && !options.allowNonLoopback) {
      return yield* configurationError("allowNonLoopback", "expected true or omission")
    }

    const suppliedFlavors = networked ? options.acceptedFlavors ?? ["sys"] : ["sys", "none"]

    if (
      !Array.isArray(suppliedFlavors) || suppliedFlavors.length === 0 ||
      suppliedFlavors.some((flavor) => flavor !== "sys" && flavor !== "none") ||
      new Set(suppliedFlavors).size !== suppliedFlavors.length
    ) return yield* configurationError("acceptedFlavors", "expected distinct sys or none flavors")

    const acceptedFlavors = Object.freeze([...suppliedFlavors])

    const socketServer = yield* SocketServer.SocketServer
    const socketAddress = socketServer.address

    const address = yield* Schema.decodeEffect(NfsServerAddress)(
      Predicate.isTagged(socketAddress, "UnixPathAddress")
        ? { path: socketAddress.path }
        : {
          host: socketAddress.address.toString(),
          port: socketAddress.port
        }
    ).pipe(
      Effect.mapError(() =>
        configurationError(
          "socketServer.address",
          "socket server must bind a TCP address or a UNIX-domain socket path"
        )
      )
    )

    if ("host" in address && address.host !== "127.0.0.1" && address.host !== "::1") {
      if (!networked) return yield* configurationError("policy", "non-loopback binding requires a policy")

      if (options.allowNonLoopback !== true) {
        return yield* configurationError("allowNonLoopback", "non-loopback binding requires explicit opt-in")
      }
    }

    const volumeCaller = yield* options.volume
      .caller()
      .pipe(
        Effect.mapError(() => configurationError("volume", "volume could not create a caller"))
      )

    if (options.caller !== undefined) {
      const [volumeRoot, callerRoot] = yield* Effect.all([
        volumeCaller.rootReference,
        options.caller.rootReference
      ]).pipe(Effect.mapError(() => configurationError("caller", "caller must be open and belong to volume")))

      if (volumeRoot !== callerRoot) {
        return yield* configurationError("caller", "caller must belong to volume")
      }
    }

    const crypto = yield* Crypto.Crypto

    const generation = yield* crypto.randomBytes(16).pipe(
      Effect.mapError((cause) => new NfsServerError({ cause }))
    )

    const identity = Result.getOrThrow(Encoding.decodeHex(options.volume.identity))
    const storageGeneration = Result.getOrThrow(Encoding.decodeHex(options.volume.incarnation))
    const export_ = makeExport(options.caller ?? volumeCaller, storageGeneration, limits, identity, options.volume)
    const callers = new Map<string, Vfs.Caller>()

    const callerFor = policy === undefined ?
      undefined :
      (call: CompoundCall): Effect.Effect<Vfs.Caller | null> =>
        Effect.gen(function*() {
          const peer = call.connection.peer

          if (peer === undefined) return null

          const credential: NfsCredential = Predicate.isTagged(call.credentials, "Sys")
            ? {
              flavor: "sys",
              uid: call.credentials.uid,
              gid: call.credentials.gid,
              groups: call.credentials.supplementaryGroups,
              machineName: call.credentials.machineName
            }
            : { flavor: "none" }

          if (!acceptedFlavors.includes(credential.flavor)) return null

          const mapped = yield* Effect.sync(() => {
            try {
              return policy({ credential, peer })
            } catch {
              return null
            }
          })

          if (mapped === null || !Schema.is(Vfs.Identity)(mapped)) return null

          const key = [
            mapped.uid,
            mapped.gid,
            mapped.privileged ? 1 : 0,
            mapped.groups.length,
            [...mapped.groups].sort((a, b) => a - b)
          ].flat().join(":")

          const existing = callers.get(key)

          if (existing !== undefined) return existing

          if (callers.size >= limits.maxIdentities) return null
          const created = yield* options.volume.caller({ identity: mapped }).pipe(Effect.orElseSucceed(() => null))

          if (created !== null) callers.set(key, created)

          return created
        })

    const handlerOptions = {
      generation,
      storageGeneration,
      leaseDurationSeconds: config.leaseDurationSeconds,
      callbackTimeout: Duration.seconds(config.callbackTimeoutSeconds),
      limits,
      securityFlavors: acceptedFlavors.map((flavor) => flavor === "sys" ? 1 : 0),
      now: Date.now
    }

    const handler = yield* makeNfs4Handler(
      export_,
      callerFor === undefined ? handlerOptions : { ...handlerOptions, callerFor }
    )

    yield* startServer(
      socketServer,
      networked ? { limits, peer: options.peer } : { limits },
      handler
    ).pipe(
      Effect.mapError(
        (cause: SocketServer.SocketServerError) => new NfsServerError({ cause })
      )
    )

    return { address }
  })

/**
 * The running NFS server, exposing the address it bound to.
 *
 * @category services
 * @since 0.1.0
 */
export class NfsServer extends Context.Service<NfsServer, {
  readonly address: NfsServerAddress
}>()(
  "@effect-vfs/nfs/NfsServer"
) {
  static readonly make = make
  static readonly layer = (
    options: NfsServerOptions
  ): Layer.Layer<
    NfsServer,
    ConfigurationError | NfsServerError,
    SocketServer.SocketServer | Crypto.Crypto
  > => Layer.effect(this, make(options))
}
