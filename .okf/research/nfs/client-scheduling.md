---
type: Research Report
title: NFS cross-client scheduling measurement
description: Separates session-only request admission, same-volume read latency, and injected storage delay in the current NFS handler.
status: stable
tags: [nfs, concurrency, capacity]
sources:
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/366
    title: Cross-client scheduling investigation
  - resource: https://github.com/lloydrichards/effect-virtual-fs/issues/239
    title: Session replay and state ownership work
  - resource: ../../../packages/nfs/src/internal/nfs4.ts
    title: Compound admission and lease sweep gate
  - resource: ../../../packages/nfs/benchmarks/clientScheduling.measure.ts
    title: Reproducible in-process experiment
  - resource: ../../../packages/core/src/LiveVolume.ts
    title: Live volume store contract
---

# NFS cross-client scheduling measurement

An unrelated session-only compound waited approximately as long as an injected storage delay in another client's
compound. A direct core read from a separate file on the same live volume also waited. Keep global NFS
serialization until a named workload needs different latency and the session and reservation design has been reviewed.

## Reproduce

Build the NFS package and its dependencies, then run the opt-in measurement:

```sh
bun install --frozen-lockfile
bun run build --filter=@effect-vfs/nfs
bun run --cwd packages/nfs benchmark:scheduling --pool=threads --maxWorkers=1
```

Each invocation writes raw JSON samples to stdout. It warms up once per setting, then alternates ten samples with
no injected delay and ten with a requested 40 ms delay. Each sample creates a fresh live volume and handler. Two local
connection doubles establish distinct sessions using the existing test harness. The writer issues a normal OPEN that
creates a file, which submits an image to a fake LiveImageStore. After the store is entered, the runner submits
SEQUENCE alone from the second session and a direct core read of an existing unrelated file. The store waits until
both probes have been submitted, then sleeps for the configured duration and acknowledges the image. Responses and
file contents are checked. The dedicated scheduling command runs separately from the shared test suite.

## Separate the waits

- **Store interval.** Time inside the commit callback, including the probe-start handshake and any injected sleep.
- **NFS admission.** Time from the second session's submission to entry into `callerFor`, the first callback under the
  handler permit. The SEQUENCE-only compound performs no core filesystem operation. Its elapsed time before the
  callback therefore measures permit admission plus local fiber scheduling.
- **After acknowledgement.** The portion of NFS admission from the store acknowledgement to `callerFor`. It includes
  remaining work on the first compound and fiber scheduling.
- **Direct core read.** Time from invocation to completion on the same volume, without NFS admission. It includes core
  coordination and read work. The sample does not separately instrument the core gate.

Two invocations on Bun 1.4.4, Effect 4.1.4, Linux 7.2.15 x86-64, Intel Core i5-10500T, base `f65a9cd3`.
The table shows median and observed min–max in milliseconds, with 20 measured samples per setting.

| Interval                              | No injected delay | 40 ms requested delay |
| ------------------------------------- | ----------------: | --------------------: |
| Store interval                        |  0.10 (0.07–0.38) |   40.22 (40.16–45.38) |
| SEQUENCE total                        |  2.39 (1.91–8.17) |   42.90 (42.15–49.86) |
| NFS admission                         |  2.10 (1.68–7.72) |   42.61 (41.93–49.59) |
| Admission after store acknowledgement |  2.04 (1.59–7.49) |      2.41 (1.77–6.37) |
| SEQUENCE after admission              |  0.31 (0.23–0.52) |      0.28 (0.22–0.44) |
| Direct core read                      |  1.67 (1.29–7.09) |   42.06 (41.62–49.17) |

The injected delay accounts for most of the increase in NFS admission, while SEQUENCE work after admission stays
below a millisecond in these runs. The direct read shows that removing NFS admission alone would leave a
same-volume coordination wait for filesystem work in this scenario. The two waits overlap in time and should
not be added together.

The experiment uses an in-process handler, an injected delay, and a fixed lease clock. It does not measure socket
or storage service overhead, lease reclamation latency, throughput, or a proposed concurrent schedule. Compare retaining
global serialization with session-slot ownership and bounded global reservation transitions only if a measured
consumer requires it. Before any scheduler implementation, demonstrate replay, cancellation, same-file share
reservations, and cross-session lock behavior under the proposed schedule.
