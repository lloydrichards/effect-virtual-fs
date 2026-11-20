// Measure the public mount and provider entry points without instrumenting timed calls.
/* eslint-disable effecttsgo/async-function, effecttsgo/node-builtin-import */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { create, MemoryProvider } from "node:vfs"
import { expect, test } from "vitest"
import { mount, type Mountable } from "../mounted/fixture.js"

const directory = "/one/two/three/four/five/six/seven/eight"

const name = `${directory}/data.bin`

const payload = Buffer.alloc(4096, 0x41)

test.for([1, 2])("4 KiB read routing (round %i)", async (round, { bench, onTestFinished }) => {
  const effect = await mount()
  onTestFinished(() => effect.close())

  const memory = new MemoryProvider()
  // SAFETY: The pinned Node runtime exposes mount and unmount.
  const node = create(memory) as Mountable
  const nodeRoot = node.mount()
  onTestFinished(() => node.unmount())

  const fixtures = [
    { label: "Effect VFS", root: effect.root, direct: create(effect.provider) },
    { label: "Node MemoryProvider", root: nodeRoot, direct: create(memory) }
  ]

  const candidates = fixtures.flatMap(({ direct, label, root }) => {
    const path = `${root}${name}`
    mkdirSync(`${root}${directory}`, { recursive: true })
    writeFileSync(path, payload)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path)).toEqual(payload)
    expect(direct.readFileSync(name)).toEqual(payload)

    return [
      bench(`${label} mounted read`, { async: false }, () => readFileSync(path)),
      bench(`${label} mounted existence probe`, { async: false }, () => existsSync(path)),
      bench(`${label} direct VFS read`, { async: false }, () => direct.readFileSync(name))
    ]
  })

  if (round === 2) candidates.reverse()
  await bench.compare(...candidates, { time: 300 })
})
