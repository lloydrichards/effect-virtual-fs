import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as InodeTable from "./inodeTable.js"
import type { Ino } from "./volumeState.js"

interface Entry {
  readonly name: string
  readonly ino: Ino
  readonly index: number
}

// Name lookup and insertion order share immutable trees. Deleted slots are compacted once they outnumber live entries.
class DirectoryEntries implements ReadonlyMap<string, Ino> {
  readonly [Symbol.toStringTag] = "Map"

  constructor(
    readonly names: HashMap.HashMap<string, Entry>,
    readonly slots: InodeTable.InodeTable<Entry>,
    readonly length: number
  ) {}

  get size(): number {
    return HashMap.size(this.names)
  }

  get(name: string): Ino | undefined {
    const slot = HashMap.get(this.names, name)

    return Option.isSome(slot) ? slot.value.ino : undefined
  }

  has(name: string): boolean {
    return HashMap.has(this.names, name)
  }

  *entries(): IterableIterator<[string, Ino]> {
    for (let index = 0; index < this.length; index++) {
      const entry = InodeTable.get(this.slots, index)

      if (entry !== undefined) yield [entry.name, entry.ino]
    }
  }

  *keys(): IterableIterator<string> {
    for (const [name] of this) yield name
  }

  *values(): IterableIterator<Ino> {
    for (const [, ino] of this) yield ino
  }

  [Symbol.iterator](): IterableIterator<[string, Ino]> {
    return this.entries()
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- ReadonlyMap forwards the opaque callback receiver without inspecting it.
  forEach(callback: (value: Ino, key: string, map: ReadonlyMap<string, Ino>) => void, thisArg?: unknown): void {
    for (const [name, ino] of this) callback.call(thisArg, ino, name, this)
  }
}

const fromEntries = (entries: ReadonlyMap<string, Ino>): DirectoryEntries => {
  let names = HashMap.empty<string, Entry>()
  let slots = InodeTable.empty<Entry>()
  let length = 0
  const owner = Symbol()

  for (const [name, ino] of entries) {
    const entry = { name, ino, index: length }
    names = HashMap.set(names, name, entry)
    slots = InodeTable.set(slots, length, entry, owner)
    length++
  }

  return new DirectoryEntries(names, slots, length)
}

/** @internal */
export const set = (entries: ReadonlyMap<string, Ino>, name: string, ino: Ino): ReadonlyMap<string, Ino> => {
  const current = entries instanceof DirectoryEntries ? entries : fromEntries(entries)
  const existing = HashMap.get(current.names, name)
  const index = Option.isSome(existing) ? existing.value.index : current.length

  const entry = { name, ino, index }

  return new DirectoryEntries(
    HashMap.set(current.names, name, entry),
    InodeTable.set(current.slots, index, entry),
    Option.isSome(existing) ? current.length : current.length + 1
  )
}

/** @internal */
export const remove = (entries: ReadonlyMap<string, Ino>, name: string): ReadonlyMap<string, Ino> => {
  const current = entries instanceof DirectoryEntries ? entries : fromEntries(entries)
  const existing = HashMap.get(current.names, name)

  if (Option.isNone(existing)) return current

  const removed = new DirectoryEntries(
    HashMap.remove(current.names, name),
    InodeTable.set(current.slots, existing.value.index, undefined),
    current.length
  )

  return removed.length > removed.size * 2 ? fromEntries(removed) : removed
}
