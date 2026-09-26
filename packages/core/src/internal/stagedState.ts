import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { FsFailure } from "../VfsError.js"
import { fsFailure } from "./errors.js"

type CommitOutcome = "committed" | "rejected" | "unknown"

/** @internal */
export interface CommitProvider<State> {
  /** Preparation failures leave the volume available. */
  readonly prepare?: (candidate: State) => Effect.Effect<void, FsFailure>
  readonly commit: (candidate: State) => Effect.Effect<CommitOutcome>
}

/** @internal */
export interface Classified {
  readonly available: boolean
  readonly failure: FsFailure | undefined
}

// An unknown commit outcome stops the volume; definite rejection stops it only during cleanup.
/** @internal */
export const offerCommit = <State>(
  provider: CommitProvider<State>,
  operation: string,
  candidate: State,
  cleanup: boolean
): Effect.Effect<Classified> =>
  Effect.map(Effect.exit(Effect.suspend(() => provider.commit(candidate))), (committed): Classified => {
    // TODO(#186): Preserve the cause of a provider defect or interruption.
    if (Exit.isFailure(committed)) {
      return { available: false, failure: fsFailure("OutcomeUnknown", operation) }
    }

    if (committed.value === "rejected") {
      return { available: !cleanup, failure: fsFailure("StorageRejected", operation) }
    }

    if (committed.value === "unknown") {
      return { available: false, failure: fsFailure("OutcomeUnknown", operation) }
    }

    return { available: true, failure: undefined }
  })
