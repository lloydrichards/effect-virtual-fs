// The benchmark measures synchronous calls through the experimental Node mount API.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { create } from "node:vfs"
import { expect, test } from "vitest"
import { mount, type Mountable } from "../mounted/fixture.js"

const parent = "/one/two/three/four/five/six/seven"

const directory = `${parent}/eight`

const directories = Array.from({ length: 8 }, (_, index) => `d${index}`)

const files = Array.from({ length: 16 }, (_, index) => `f${String(index).padStart(2, "0")}`)

const treeData = Buffer.alloc(512, 45)

const initial = Buffer.alloc(4096, 41)

const replacement = Buffer.alloc(4096, 42)

const operations = 32

const fileCount = directories.length * files.length

const enumerate = (tree: string) =>
  readdirSync(tree).sort().flatMap((name) => {
    const child = `${tree}/${name}`

    return readdirSync(child).sort().map((file) => `${child}/${file}`)
  })

const byteCheck = (bytes: Buffer) => bytes.length + (bytes[0] ?? 0)

interface Fixture {
  readonly tree: string
  readonly paths: ReadonlyArray<string>
  readonly repeat: string
}

const workloads = [
  {
    name: "list 128-file tree",
    run: ({ tree }: Fixture) => enumerate(tree).length,
    expected: fileCount
  },
  {
    name: "stat 128 known files",
    run: ({ paths }: Fixture) => paths.reduce((sum, path) => sum + statSync(path).size, 0),
    expected: fileCount * treeData.length
  },
  {
    name: "read 128 known 512 B files",
    run: ({ paths }: Fixture) => paths.reduce((sum, path) => sum + byteCheck(readFileSync(path)), 0),
    expected: fileCount * byteCheck(treeData)
  },
  {
    name: "list, stat and read 128-file tree",
    run: ({ tree }: Fixture) =>
      enumerate(tree).reduce((sum, path) => sum + statSync(path).size + byteCheck(readFileSync(path)), 0),
    expected: fileCount * (treeData.length + byteCheck(treeData))
  },
  {
    name: "repeat 4 KiB read (32 calls)",
    run: ({ repeat }: Fixture) => {
      let sum = 0

      for (let index = 0; index < operations; index++) sum += byteCheck(readFileSync(repeat))

      return sum
    },
    expected: operations * byteCheck(initial)
  },
  {
    name: "repeat 4 KiB overwrite (32 calls)",
    run: ({ repeat }: Fixture) => {
      for (let index = 0; index < operations; index++) writeFileSync(repeat, index % 2 === 0 ? initial : replacement)

      return operations
    },
    expected: operations,
    written: replacement
  }
]

const prepare = (root: string): Fixture => {
  const tree = `${root}${directory}`
  const repeatDirectory = `${root}${parent}/repeat`
  const repeat = `${repeatDirectory}/data.bin`

  const paths = directories.flatMap((name) => {
    const child = `${tree}/${name}`
    mkdirSync(child, { recursive: true })

    return files.map((file) => {
      const path = `${child}/${file}`
      writeFileSync(path, treeData)

      return path
    })
  })

  mkdirSync(repeatDirectory)
  writeFileSync(repeat, initial)
  expect(enumerate(tree)).toEqual(paths)

  return { tree, paths, repeat }
}

const rounds = workloads.flatMap((workload) => [1, 2].map((round) => ({ ...workload, round })))

test.for(rounds)(
  "$name (round $round)",
  async ({ expected, round, run, written = initial }, { bench, onTestFinished }) => {
    const effect = await mount()
    onTestFinished(() => effect.close())

    // SAFETY: Node 26.11.1 exposes mount and unmount on the VFS instance.
    const node = create() as Mountable
    const nodeRoot = node.mount()
    onTestFinished(() => node.unmount())

    const effectFixture = prepare(effect.root)
    const nodeFixture = prepare(nodeRoot)

    for (const fixture of [effectFixture, nodeFixture]) {
      expect(run(fixture)).toBe(expected)
      expect(readFileSync(fixture.repeat)).toEqual(written)
      writeFileSync(fixture.repeat, initial)
    }

    const candidates = [
      bench("Effect VFS provider", { async: false }, () => run(effectFixture)),
      bench("Node MemoryProvider", { async: false }, () => run(nodeFixture))
    ]

    if (round === 2) candidates.reverse()
    await bench.compare(...candidates, { time: 300 })

    for (const fixture of [effectFixture, nodeFixture]) expect(readFileSync(fixture.repeat)).toEqual(written)
  }
)
