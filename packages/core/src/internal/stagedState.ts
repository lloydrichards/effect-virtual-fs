// Classifies what a storage adapter says about a committed candidate.
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type { FsFailure } from "../VfsError.js"
import { fsFailure } from "./errors.js"

type CommitOutcome = "committed" | "rejected" | "unknown"

/** @internal */
export interface CommitProvider<State> {
  /** Checks and encodes a candidate before the commit boundary. Failure leaves the volume available. */
  readonly prepare?: (candidate: State) => Effect.Effect<void, FsFailure>
  /** Classifies a candidate as committed, definitely rejected, or uncertain. */
  readonly commit: (candidate: State) => Effect.Effect<CommitOutcome>
}

/** @internal */
export interface Classified {
  /** Whether the volume may keep serving; false once storage's word cannot be relied on. */
  readonly available: boolean
  readonly failure: FsFailure | undefined
}

// Offers a candidate to the provider and reads its answer. A defect or interruption inside the provider, or an
// uncertain outcome, stops the volume: nothing can say whether storage took the candidate. A definite rejection
// stops it only when the change was a cleanup that must not be retried.
/** @internal */
export const offerCommit = <State>(
  provider: CommitProvider<State>,
  operation: string,
  candidate: State,
  cleanup: boolean
): Effect.Effect<Classified> =>
  Effect.map(Effect.exit(Effect.suspend(() => provider.commit(candidate))), (committed): Classified => {
    // TODO(#186): a failed commit exit is a defect or interruption inside the provider, so the error keeps no cause.
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
