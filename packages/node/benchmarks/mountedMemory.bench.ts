// The benchmark measures native mounted Node filesystem calls in Vitest.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { create } from "node:vfs"
import { expect, test } from "vitest"
import { mount, type Mountable } from "../mounted/fixture.js"

const directory = "/one/two/three/four/five/six/seven/eight"

const initial = Buffer.alloc(4096, 0x41)

const replacement = Buffer.alloc(4096, 0x42)

const workloads = [
  {
    name: "stat file under eight directories",
    run: (path: string) => statSync(path)
  },
  {
    name: "read 4 KiB file",
    run: (path: string) => readFileSync(path)
  },
  {
    name: "overwrite 4 KiB file",
    run: (path: string) => writeFileSync(path, replacement),
    expected: replacement
  }
]

const rounds = workloads.flatMap((workload) => [1, 2].map((round) => ({ ...workload, round })))

test.for(rounds)("$name (round $round)", async ({ expected = initial, round, run }, { bench, onTestFinished }) => {
  const effect = await mount()
  onTestFinished(() => effect.close())

  // SAFETY: Node 26.11.1 exposes mount and unmount on the VFS instance.
  const node = create() as Mountable
  const nodeRoot = node.mount()
  onTestFinished(() => node.unmount())

  const effectPath = effect.path(`${directory}/data.bin`)
  const nodePath = `${nodeRoot}${directory}/data.bin`

  for (const [root, path] of [[effect.root, effectPath], [nodeRoot, nodePath]] as const) {
    mkdirSync(`${root}${directory}`, { recursive: true })
    writeFileSync(path, initial)
    expect(readFileSync(path)).toEqual(initial)
    expect(statSync(path).size).toBe(initial.length)
  }

  const candidates = [
    bench("Effect VFS provider", { async: false }, () => run(effectPath)),
    bench("Node MemoryProvider", { async: false }, () => run(nodePath))
  ]

  if (round === 2) candidates.reverse()
  await bench.compare(...candidates, { time: 300 })

  expect(readFileSync(effectPath)).toEqual(expected)
  expect(readFileSync(nodePath)).toEqual(expected)
})
