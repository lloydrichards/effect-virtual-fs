// A 32-way persistent trie. One owner may mutate paths it has already copied within a batch.

const BITS = 5
const WIDTH = 1 << BITS
const MASK = WIDTH - 1
const SHIFTABLE = 0x100000000 // Shifts wrap keys at 2^32 and shift counts at 32.
const MAX_SHIFT = 32

/** @internal */
export type Owner = symbol

interface Slots<A> {
  readonly owner: Owner | undefined
  readonly items: Array<Slots<A> | A | undefined>
}

/** @internal */
export interface InodeTable<A> {
  readonly root: Slots<A>
  readonly levels: number
  readonly capacity: number
}

/** @internal */
export const empty = <A>(): InodeTable<A> => ({ root: { owner: undefined, items: [] }, levels: 1, capacity: WIDTH })

const index = (key: number, shift: number): number =>
  key < SHIFTABLE && shift < MAX_SHIFT ? (key >>> shift) & MASK : Math.floor(key / 2 ** shift) % WIDTH

/** @internal */
export const get = <A>(table: InodeTable<A>, key: number): A | undefined => {
  if (key >= table.capacity) return undefined
  let node = table.root
  let shift = (table.levels - 1) * BITS

  while (shift > 0) {
    const next = node.items[index(key, shift)]

    if (next === undefined) return undefined
    // SAFETY: every slot above the leaf level holds a Slots value or nothing.
    node = next as Slots<A>
    shift -= BITS
  }

  // SAFETY: leaf level slots hold values or nothing.
  return node.items[key & MASK] as A | undefined
}

const setIn = <A>(
  node: Slots<A>,
  key: number,
  value: A | undefined,
  shift: number,
  owner: Owner | undefined
): Slots<A> => {
  const target = owner !== undefined && node.owner === owner ? node : { owner, items: node.items.slice() }

  if (shift === 0) target.items[key & MASK] = value
  else {
    const at = index(key, shift)
    // SAFETY: every slot above the leaf level holds a Slots value or nothing.
    const child = (node.items[at] as Slots<A> | undefined) ?? { owner: undefined, items: [] }
    target.items[at] = setIn(child, key, value, shift - BITS, owner)
  }

  return target
}

/** @internal */
export const set = <A>(table: InodeTable<A>, key: number, value: A | undefined, owner?: Owner): InodeTable<A> => {
  let { capacity, levels, root } = table

  while (key >= capacity) {
    root = { owner, items: [root] }
    levels += 1
    capacity *= WIDTH
  }

  return { root: setIn(root, key, value, (levels - 1) * BITS, owner), levels, capacity }
}
