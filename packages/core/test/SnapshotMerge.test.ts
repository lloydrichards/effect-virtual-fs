import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { assert, it } from "@effect/vitest"
import { type Crypto, Effect, Match, Option, Schema } from "effect"
import { BytePath, VirtualFileSystem as Vfs } from "../src/index.js"

const encoder = new TextEncoder()

const decoder = new TextDecoder()

const text = (value: string) => encoder.encode(value)

type Edit = (fs: Vfs.Caller) => Effect.Effect<unknown, Vfs.VfsError>

const none: Edit = () => Effect.void

const write = (path: string, value: string): Edit => (fs) =>
  fs.writeFile(path, text(value), { access: "write", truncate: true, create: "ifMissing" })

const create = (path: string, value: string): Edit => (fs) =>
  fs.writeFile(path, text(value), { access: "write", create: "exclusive" })

const remove = (path: string): Edit => (fs) => fs.remove(path, { recursive: true })

const chmod = (path: string, mode: number): Edit => (fs) => fs.chmod(path, mode)

const mkdir = (path: string): Edit => (fs) => fs.mkdir(path)

const link = (from: string, to: string): Edit => (fs) => fs.link(from, to)

const rename = (from: string, to: string): Edit => (fs) => fs.rename(from, to)

const touch = (path: string, nanoseconds: bigint): Edit => (fs) =>
  fs.utimes(path, { access: { kind: "omit" }, modification: { kind: "value", nanoseconds } })

const all = (...edits: ReadonlyArray<Edit>): Edit => (fs) => Effect.forEach(edits, (edit) => edit(fs))

// The base every table row starts from: a directory with a child, loose files, a symlink and a hard-link pair.
const fixture = Vfs.fromFixture({
  entries: [
    { kind: "directory", path: "/dir" },
    { kind: "file", path: "/dir/inner.txt", bytes: text("inner") },
    { kind: "file", path: "/shared.txt", bytes: text("v0") },
    { kind: "file", path: "/old.txt", bytes: text("old") },
    { kind: "file", path: "/r.txt", bytes: text("r") },
    { kind: "file", path: "/h", bytes: text("h") },
    { kind: "file", path: "/g1", bytes: text("g") },
    { kind: "hardLink", path: "/g2", target: "/g1" },
    { kind: "symlink", path: "/sym", target: "shared.txt" }
  ]
})

const pathText = (path: BytePath.BytePath) => Option.getOrElse(BytePath.toStringOption(path), () => "?")

const render = Match.type<Vfs.SnapshotChange>().pipe(
  Match.tag(
    "Updated",
    (change) =>
      `Updated ${pathText(change.path)} ${change.beforeKind}->${change.afterKind} [${change.differences.join(",")}]`
  ),
  Match.orElse((change) => `${change._tag} ${pathText(change.path)}:${change.kind}`)
)

const sideText = Match.type<Vfs.MergeSideChange>().pipe(
  Match.tag("Unchanged", () => "Unchanged"),
  Match.tag("Updated", (side) => `Updated ${side.beforeKind}->${side.afterKind} [${side.differences.join(",")}]`),
  Match.orElse((side) => `${side._tag}:${side.kind}`)
)

const renderConflict = (conflict: Vfs.MergeConflict) =>
  `${pathText(conflict.path)} ${conflict.reason} ours=${sideText(conflict.ours)} theirs=${sideText(conflict.theirs)}`

const resolutions = (entries: ReadonlyArray<readonly [string, Vfs.MergeTake]>) =>
  Effect.forEach(entries, ([path, take]) => BytePath.fromString(path).pipe(Effect.map((path) => ({ path, take }))))

const deltaOf = Effect.fnUntraced(function*(base: Vfs.Snapshot, edit: Edit) {
  const overlay = yield* Vfs.makeOverlay(base)
  yield* edit(yield* overlay.caller())

  return yield* Vfs.diffSnapshots(base, (yield* overlay.capture()).snapshot)
})

const merge = Effect.fnUntraced(function*(
  ours: Edit,
  theirs: Edit,
  options?: Vfs.MergeOptions,
  source: Effect.Effect<Vfs.Volume, Vfs.VfsError, Crypto.Crypto> = fixture
) {
  const base = yield* (yield* source).snapshot

  const result = yield* Vfs.mergeSnapshotDeltas(
    base,
    yield* deltaOf(base, ours),
    yield* deltaOf(base, theirs),
    options
  )

  const changes = yield* Vfs.inspectSnapshotDelta(base, result.delta)
  const merged = yield* Vfs.fromSnapshot(yield* Vfs.applySnapshotDelta(base, result.delta))
  const reader = yield* merged.caller()

  return {
    base,
    result,
    changes: changes.map(render),
    conflicts: result.conflicts.map(renderConflict),
    read: (path: string) => reader.readFile(path).pipe(Effect.map((bytes) => decoder.decode(bytes))),
    stat: (path: string) => reader.stat(path)
  }
})

interface Row {
  readonly name: string
  readonly ours: Edit
  readonly theirs: Edit
  readonly changes: ReadonlyArray<string>
  readonly conflicts: ReadonlyArray<string>
}

// One row per paired change. The rendered change list is the merged delta as `inspectSnapshotDelta` reports it.
const rows: ReadonlyArray<Row> = [
  {
    name: "disjoint edits are both taken",
    ours: write("/shared.txt", "ours"),
    theirs: create("/new.txt", "theirs"),
    changes: ["Added /new.txt:file", "Updated /shared.txt file->file [content]"],
    conflicts: []
  },
  {
    name: "the same edit on both sides is taken once",
    ours: write("/shared.txt", "same"),
    theirs: write("/shared.txt", "same"),
    changes: ["Updated /shared.txt file->file [content]"],
    conflicts: []
  },
  {
    name: "different content on both sides conflicts and keeps the base",
    ours: write("/shared.txt", "ours"),
    theirs: write("/shared.txt", "theirs"),
    changes: [],
    conflicts: ["/shared.txt BothChanged ours=Updated file->file [content] theirs=Updated file->file [content]"]
  },
  {
    name: "a mode change merges with a content change",
    ours: chmod("/shared.txt", 0o600),
    theirs: write("/shared.txt", "theirs"),
    changes: ["Updated /shared.txt file->file [content,mode]"],
    conflicts: []
  },
  {
    name: "the same mode on both sides merges",
    ours: chmod("/shared.txt", 0o600),
    theirs: chmod("/shared.txt", 0o600),
    changes: ["Updated /shared.txt file->file [mode]"],
    conflicts: []
  },
  {
    name: "different modes on both sides conflict",
    ours: chmod("/shared.txt", 0o600),
    theirs: chmod("/shared.txt", 0o640),
    changes: [],
    conflicts: ["/shared.txt BothChanged ours=Updated file->file [mode] theirs=Updated file->file [mode]"]
  },
  {
    name: "removing a file the other side edited conflicts",
    ours: remove("/old.txt"),
    theirs: write("/old.txt", "theirs"),
    changes: [],
    conflicts: ["/old.txt ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"]
  },
  {
    name: "removing a file the other side only touched in time is taken",
    ours: remove("/old.txt"),
    theirs: touch("/old.txt", 5_000n),
    changes: ["Removed /old.txt:file"],
    conflicts: []
  },
  {
    name: "removing a directory the other side added under conflicts at the added path",
    ours: remove("/dir"),
    theirs: create("/dir/new.txt", "theirs"),
    changes: [],
    conflicts: ["/dir/new.txt ParentRemoved ours=Removed:directory theirs=Added:file"]
  },
  {
    name: "removing a directory the other side edited under conflicts at the edited path",
    ours: chmod("/dir/inner.txt", 0o600),
    theirs: remove("/dir"),
    changes: [],
    conflicts: ["/dir/inner.txt ParentRemoved ours=Updated file->file [mode] theirs=Removed:directory"]
  },
  {
    name: "removing a directory the other side only removed under is taken",
    ours: remove("/dir"),
    theirs: remove("/dir/inner.txt"),
    changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file"],
    conflicts: []
  },
  {
    name: "removing a directory the other side changed in place conflicts at the directory",
    ours: remove("/dir"),
    theirs: chmod("/dir", 0o700),
    changes: [],
    conflicts: ["/dir ChangedRemoved ours=Removed:directory theirs=Updated directory->directory [mode]"]
  },
  {
    name: "a directory changed in place merges with a child added under it",
    ours: chmod("/dir", 0o700),
    theirs: create("/dir/new.txt", "theirs"),
    changes: ["Updated /dir directory->directory [mode]", "Added /dir/new.txt:file"],
    conflicts: []
  },
  {
    name: "a rename beside an edit of the old name adds the new name and conflicts at the old",
    ours: rename("/r.txt", "/moved.txt"),
    theirs: write("/r.txt", "theirs"),
    changes: ["Added /moved.txt:file"],
    conflicts: ["/r.txt ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"]
  },
  {
    name: "two renames of one file to different names add both and remove the old",
    ours: rename("/r.txt", "/a.txt"),
    theirs: rename("/r.txt", "/b.txt"),
    changes: ["Added /a.txt:file", "Added /b.txt:file", "Removed /r.txt:file"],
    conflicts: []
  },
  {
    name: "the same addition on both sides is taken once",
    ours: create("/new.txt", "same"),
    theirs: create("/new.txt", "same"),
    changes: ["Added /new.txt:file"],
    conflicts: []
  },
  {
    name: "different additions at one path conflict",
    ours: create("/new.txt", "ours"),
    theirs: create("/new.txt", "theirs"),
    changes: [],
    conflicts: ["/new.txt BothAddedDifferent ours=Added:file theirs=Added:file"]
  },
  {
    name: "a file and a directory added at one path conflict and drop the directory's children",
    ours: create("/new", "ours"),
    theirs: all(mkdir("/new"), create("/new/child.txt", "theirs")),
    changes: [],
    conflicts: ["/new BothAddedDifferent ours=Added:file theirs=Added:directory"]
  },
  {
    name: "the same directory added on both sides merges its different children",
    ours: all(mkdir("/new"), create("/new/a.txt", "ours")),
    theirs: all(mkdir("/new"), create("/new/b.txt", "theirs")),
    changes: ["Added /new:directory", "Added /new/a.txt:file", "Added /new/b.txt:file"],
    conflicts: []
  },
  {
    name: "a kind change beside an edit conflicts",
    ours: all(remove("/old.txt"), mkdir("/old.txt")),
    theirs: write("/old.txt", "theirs"),
    changes: [],
    conflicts: ["/old.txt KindDiverged ours=Updated file->directory [kind,mode] theirs=Updated file->file [content]"]
  },
  {
    name: "the same kind change on both sides merges the children beneath",
    ours: all(remove("/old.txt"), mkdir("/old.txt"), create("/old.txt/a", "ours")),
    theirs: all(remove("/old.txt"), mkdir("/old.txt"), create("/old.txt/b", "theirs")),
    changes: ["Updated /old.txt file->directory [kind,mode]", "Added /old.txt/a:file", "Added /old.txt/b:file"],
    conflicts: []
  },
  {
    name: "a new hard link merges with an edit through the existing name",
    ours: link("/h", "/h2"),
    theirs: write("/h", "theirs"),
    changes: ["Updated /h file->file [content,hardLinks]", "Added /h2:file"],
    conflicts: []
  },
  {
    name: "unlinking one name merges with an edit through the other",
    ours: remove("/g2"),
    theirs: write("/g1", "theirs"),
    changes: ["Updated /g1 file->file [content,hardLinks]", "Removed /g2:file"],
    conflicts: []
  },
  {
    name: "membership changed on both sides conflicts across the whole group",
    ours: link("/g1", "/g3"),
    theirs: remove("/g2"),
    changes: [],
    conflicts: [
      "/g1 HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
      "/g2 HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Removed:file",
      "/g3 HardLinkGroupDiverged ours=Added:file theirs=Unchanged"
    ]
  },
  {
    name: "removing every name of a node the other side edited conflicts at each name",
    ours: all(remove("/g1"), remove("/g2")),
    theirs: write("/g2", "theirs"),
    changes: [],
    conflicts: [
      "/g1 ChangedRemoved ours=Removed:file theirs=Updated file->file [content]",
      "/g2 ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"
    ]
  },
  {
    name: "linking a new name to a node the other side removed entirely conflicts at the new name",
    ours: remove("/h"),
    theirs: link("/h", "/h2"),
    changes: [],
    conflicts: ["/h2 ChangedRemoved ours=Unchanged theirs=Added:file"]
  },
  {
    name: "a symlink retargeted on one side merges with a mode change on the other",
    ours: (fs) => fs.remove("/sym").pipe(Effect.andThen(fs.symlink("old.txt", "/sym"))),
    theirs: chmod("/shared.txt", 0o600),
    changes: ["Updated /shared.txt file->file [mode]", "Updated /sym symlink->symlink [target]"],
    conflicts: []
  },
  {
    name: "nothing on either side merges to an empty delta",
    ours: none,
    theirs: none,
    changes: [],
    conflicts: []
  },
  {
    name: "a link to a node both sides added identically keeps the link",
    ours: create("/new.txt", "n"),
    theirs: all(create("/new.txt", "n"), link("/new.txt", "/zz")),
    changes: ["Added /new.txt:file", "Added /zz:file"],
    conflicts: []
  },
  {
    name: "a hard link and a fresh file with the same bytes added at one path conflict",
    ours: link("/h", "/new"),
    theirs: create("/new", "h"),
    changes: [],
    conflicts: ["/new BothAddedDifferent ours=Added:file theirs=Added:file"]
  },
  {
    name: "a conflict side that also touched timestamps reports only its real differences",
    ours: remove("/old.txt"),
    theirs: all(write("/old.txt", "t"), touch("/old.txt", 9_000n)),
    changes: [],
    conflicts: ["/old.txt ChangedRemoved ours=Removed:file theirs=Updated file->file [content]"]
  },
  {
    name: "removing one name and replacing the other's kind while the other side edits conflicts at both",
    ours: all(remove("/g1"), remove("/g2"), mkdir("/g2")),
    theirs: write("/g1", "theirs"),
    changes: [],
    conflicts: [
      "/g1 ChangedRemoved ours=Removed:file theirs=Updated file->file [content]",
      "/g2 KindDiverged ours=Updated file->directory [kind,hardLinks,mode] theirs=Updated file->file [content]"
    ]
  },
  {
    name: "the same kind change with different modes conflicts",
    ours: all(remove("/old.txt"), mkdir("/old.txt"), chmod("/old.txt", 0o700)),
    theirs: all(remove("/old.txt"), mkdir("/old.txt")),
    changes: [],
    conflicts: [
      "/old.txt KindDiverged ours=Updated file->directory [kind,mode] theirs=Updated file->directory [kind,mode]"
    ]
  },
  {
    name: "replacing a directory with a file while the other side edits beneath conflicts beneath",
    ours: all(remove("/dir"), create("/dir", "flat")),
    theirs: chmod("/dir/inner.txt", 0o600),
    changes: [],
    conflicts: [
      "/dir/inner.txt ParentRemoved ours=Updated directory->file [kind,mode] theirs=Updated file->file [mode]"
    ]
  },
  {
    name: "removing a directory the other side only touched in time beneath is taken",
    ours: remove("/dir"),
    theirs: touch("/dir/inner.txt", 9_000n),
    changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file"],
    conflicts: []
  },
  {
    name: "different root modes conflict while children still merge",
    ours: all(chmod("/", 0o700), create("/ours.txt", "o")),
    theirs: all(chmod("/", 0o750), create("/theirs.txt", "t")),
    changes: ["Added /ours.txt:file", "Added /theirs.txt:file"],
    conflicts: ["/ BothChanged ours=Updated directory->directory [mode] theirs=Updated directory->directory [mode]"]
  },
  {
    name: "a split name beside an edit through the old name keeps both nodes",
    ours: all(remove("/g2"), create("/g2", "new")),
    theirs: write("/g1", "theirs"),
    changes: ["Updated /g1 file->file [content,hardLinks]", "Updated /g2 file->file [content,hardLinks]"],
    conflicts: []
  },
  {
    name: "a split name beside a mode change through the old name keeps the mode on the old node",
    ours: all(remove("/g2"), create("/g2", "new")),
    theirs: chmod("/g1", 0o600),
    changes: ["Updated /g1 file->file [hardLinks,mode]", "Updated /g2 file->file [content,hardLinks]"],
    conflicts: []
  },
  {
    name: "two sides that each unlink a different name of one node remove both",
    ours: remove("/g1"),
    theirs: remove("/g2"),
    changes: ["Removed /g1:file", "Removed /g2:file"],
    conflicts: []
  },
  {
    name: "removing every name while the other side unlinks one removes the node",
    ours: all(remove("/g1"), remove("/g2")),
    theirs: remove("/g2"),
    changes: ["Removed /g1:file", "Removed /g2:file"],
    conflicts: []
  },
  {
    name: "removing a directory the other side only touched in time is taken",
    ours: remove("/dir"),
    theirs: touch("/dir", 9_000n),
    changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file"],
    conflicts: []
  },
  {
    name: "a node rewritten in place and given a name from another node merges with an edit of the other node",
    ours: all(remove("/g1"), remove("/h"), create("/h", "fresh"), link("/h", "/g1")),
    theirs: write("/g2", "theirs"),
    changes: [
      "Updated /g1 file->file [content,hardLinks]",
      "Updated /g2 file->file [content,hardLinks]",
      "Updated /h file->file [content,hardLinks]"
    ],
    conflicts: []
  }
]

// A base with a three-name group, a link reaching into a directory, two loose files and a symlink.
const linkFixture = Vfs.fromFixture({
  entries: [
    { kind: "directory", path: "/dir" },
    { kind: "file", path: "/dir/inner.txt", bytes: text("inner") },
    { kind: "file", path: "/h", bytes: text("h") },
    { kind: "hardLink", path: "/dir/l", target: "/h" },
    { kind: "file", path: "/a", bytes: text("a") },
    { kind: "file", path: "/b", bytes: text("b") },
    { kind: "file", path: "/t1", bytes: text("t") },
    { kind: "hardLink", path: "/t2", target: "/t1" },
    { kind: "hardLink", path: "/t3", target: "/t1" },
    { kind: "symlink", path: "/sym", target: "a" }
  ]
})

// `point(name, target)` removes `name` and links it to `target`'s node.
const point = (name: string, target: string): Edit => all(remove(name), link(target, name))

const linkRows: ReadonlyArray<Row> = [
  {
    name: "a new link whose name sorts first carries the other side's edit",
    ours: link("/h", "/0"),
    theirs: write("/h", "t"),
    changes: [
      "Added /0:file",
      "Updated /dir/l file->file [content,hardLinks]",
      "Updated /h file->file [content,hardLinks]"
    ],
    conflicts: []
  },
  {
    name: "a name pointed at another node beside an edit of that name conflicts without touching the target",
    ours: point("/a", "/b"),
    theirs: write("/a", "t"),
    changes: [],
    conflicts: ["/a ChangedRemoved ours=Updated file->file [content,hardLinks] theirs=Updated file->file [content]"]
  },
  {
    name: "two names pointed at each other's nodes conflict across the group",
    ours: point("/a", "/h"),
    theirs: point("/h", "/a"),
    changes: [],
    conflicts: [
      "/a HardLinkGroupDiverged ours=Updated file->file [content,hardLinks] theirs=Updated file->file [hardLinks]",
      "/dir/l HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
      "/h ChangedRemoved ours=Updated file->file [hardLinks] theirs=Updated file->file [content,hardLinks]"
    ]
  },
  {
    name: "one name pointed at two different nodes by the two sides conflicts at that name",
    ours: point("/a", "/b"),
    theirs: point("/a", "/h"),
    changes: [],
    conflicts: [
      "/a BothChanged ours=Updated file->file [content,hardLinks] theirs=Updated file->file [content,hardLinks]"
    ]
  },
  {
    name: "both sides removing a directory while one also removes a node's last name removes the node",
    ours: all(remove("/dir"), remove("/h")),
    theirs: remove("/dir"),
    changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file", "Removed /dir/l:file", "Removed /h:file"],
    conflicts: []
  },
  {
    name: "a conflicted group under a removed directory keeps the directory",
    ours: remove("/dir"),
    theirs: all(remove("/dir/l"), link("/h", "/h2")),
    changes: [],
    conflicts: [
      "/dir/l HardLinkGroupDiverged ours=Removed:file theirs=Removed:file",
      "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
      "/h2 HardLinkGroupDiverged ours=Unchanged theirs=Added:file"
    ]
  },
  {
    name: "the same link on both sides beside an edit through the old name merges",
    ours: all(link("/h", "/h2"), write("/h", "o")),
    theirs: link("/h", "/h2"),
    changes: [
      "Updated /dir/l file->file [content,hardLinks]",
      "Updated /h file->file [content,hardLinks]",
      "Added /h2:file"
    ],
    conflicts: []
  },
  {
    name: "a removed directory holding a linked name beside a new link is reported once per path",
    ours: remove("/dir"),
    theirs: link("/h", "/h2"),
    changes: [],
    conflicts: [
      "/dir/l HardLinkGroupDiverged ours=Removed:file theirs=Updated file->file [hardLinks]",
      "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [hardLinks]",
      "/h2 HardLinkGroupDiverged ours=Unchanged theirs=Added:file"
    ]
  },
  {
    name: "unlinking two different names of a three-name node removes both",
    ours: remove("/t1"),
    theirs: remove("/t3"),
    changes: ["Removed /t1:file", "Updated /t2 file->file [hardLinks]", "Removed /t3:file"],
    conflicts: []
  },
  {
    name: "removing a directory with a linked name beside an edit of its other file conflicts and keeps the group",
    ours: remove("/dir"),
    theirs: chmod("/dir/inner.txt", 0o600),
    changes: [],
    conflicts: [
      "/dir/inner.txt ParentRemoved ours=Removed:directory theirs=Updated file->file [mode]",
      "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged"
    ]
  },
  {
    name: "a new name linked to different nodes by the two sides conflicts and ties both nodes",
    ours: link("/a", "/c"),
    theirs: link("/b", "/c"),
    changes: [],
    conflicts: ["/c BothAddedDifferent ours=Added:file theirs=Added:file"]
  },
  {
    name: "a new name linked to different nodes holds back an edit of one of them",
    ours: all(link("/a", "/c"), write("/a", "x")),
    theirs: link("/b", "/c"),
    changes: [],
    conflicts: ["/c BothAddedDifferent ours=Added:file theirs=Added:file"]
  },
  {
    name: "replacing a directory with a link while the other side adds beneath it conflicts beneath",
    ours: all(remove("/dir"), link("/a", "/dir")),
    theirs: create("/dir/new.txt", "n"),
    changes: [],
    conflicts: [
      "/a HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged",
      "/dir/new.txt ParentRemoved ours=Updated directory->file [kind,hardLinks,mode] theirs=Added:file",
      "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged"
    ]
  },
  {
    name: "a directory and a linked file moved to one new name conflict there",
    ours: rename("/dir", "/n"),
    theirs: rename("/t1", "/n"),
    changes: [],
    conflicts: [
      "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Unchanged",
      "/n BothAddedDifferent ours=Added:directory theirs=Added:file",
      "/t2 HardLinkGroupDiverged ours=Unchanged theirs=Updated file->file [hardLinks]",
      "/t3 HardLinkGroupDiverged ours=Unchanged theirs=Updated file->file [hardLinks]"
    ]
  },
  {
    name: "the same join on both sides merges with an edit of the joined node on one side",
    ours: all(point("/t1", "/h"), write("/h", "x")),
    theirs: point("/t1", "/h"),
    changes: [
      "Updated /dir/l file->file [content,hardLinks]",
      "Updated /h file->file [content,hardLinks]",
      "Updated /t1 file->file [content,hardLinks]",
      "Updated /t2 file->file [hardLinks]",
      "Updated /t3 file->file [hardLinks]"
    ],
    conflicts: []
  },
  {
    name: "a join with an edit on one side merges with an unlink of the joined node on the other",
    ours: all(point("/t1", "/h"), write("/h", "x")),
    theirs: remove("/t2"),
    changes: [
      "Updated /dir/l file->file [content,hardLinks]",
      "Updated /h file->file [content,hardLinks]",
      "Updated /t1 file->file [content,hardLinks]",
      "Removed /t2:file",
      "Updated /t3 file->file [hardLinks]"
    ],
    conflicts: []
  },
  {
    name: "a withheld edit of a linked node outside a conflicted directory is reported",
    ours: remove("/dir"),
    theirs: all(write("/h", "x"), create("/dir/new.txt", "n"), write("/a", "a2")),
    changes: ["Updated /a file->file [content]"],
    conflicts: [
      "/dir/new.txt ParentRemoved ours=Removed:directory theirs=Added:file",
      "/h HardLinkGroupDiverged ours=Updated file->file [hardLinks] theirs=Updated file->file [content]"
    ]
  },
  {
    name: "removing a directory with a linked name beside a removal of the node's other name removes everything",
    ours: remove("/dir"),
    theirs: remove("/h"),
    changes: ["Removed /dir:directory", "Removed /dir/inner.txt:file", "Removed /dir/l:file", "Removed /h:file"],
    conflicts: []
  },
  {
    name: "a symlink linked under a new first name carries the other side's retarget",
    ours: link("/sym", "/0"),
    theirs: (fs) => fs.remove("/sym").pipe(Effect.andThen(fs.symlink("b", "/sym"))),
    changes: ["Added /0:symlink", "Updated /sym symlink->symlink [target,hardLinks]"],
    conflicts: []
  }
]

it.layer(BunCrypto.layer)("snapshot delta merge", (it) => {
  for (const row of rows) {
    it.effect(`should ${row.name}`, () =>
      Effect.gen(function*() {
        const outcome = yield* merge(row.ours, row.theirs)

        assert.deepStrictEqual(outcome.changes, row.changes)
        assert.deepStrictEqual(outcome.conflicts, row.conflicts)
      }))
  }

  it.effect("should leave the base bytes at a conflicted path and apply the other changes", () =>
    Effect.gen(function*() {
      const outcome = yield* merge(
        all(write("/shared.txt", "ours"), create("/ours.txt", "o")),
        all(write("/shared.txt", "theirs"), create("/theirs.txt", "t"))
      )

      assert.strictEqual(yield* outcome.read("/shared.txt"), "v0")
      assert.strictEqual(yield* outcome.read("/ours.txt"), "o")
      assert.strictEqual(yield* outcome.read("/theirs.txt"), "t")
    }))

  it.effect("should write the edited bytes through every name of a merged hard-link group", () =>
    Effect.gen(function*() {
      const outcome = yield* merge(link("/h", "/h2"), write("/h", "theirs"))

      assert.strictEqual(yield* outcome.read("/h"), "theirs")
      assert.strictEqual(yield* outcome.read("/h2"), "theirs")
      assert.strictEqual((yield* outcome.stat("/h2")).nlink, 2)
    }))

  it.effect("should take the later modification time when both sides changed it", () =>
    Effect.gen(function*() {
      for (const [ours, theirs] of [[100_000n, 200_000n], [200_000n, 100_000n]] as const) {
        const outcome = yield* merge(touch("/shared.txt", ours), touch("/shared.txt", theirs))

        assert.deepStrictEqual(outcome.conflicts, [])
        assert.strictEqual((yield* outcome.stat("/shared.txt")).mtimeNs, 200_000n)
      }
    }))

  it.effect("should take the side a resolution names at a conflicted path", () =>
    Effect.gen(function*() {
      const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake) {
        return yield* merge(write("/shared.txt", "ours"), write("/shared.txt", "theirs"), {
          resolutions: yield* resolutions([["/shared.txt", take]])
        })
      })

      const ours = yield* resolve("ours")
      const theirs = yield* resolve("theirs")
      const base = yield* resolve("base")

      assert.deepStrictEqual(ours.conflicts, [])
      assert.strictEqual(yield* ours.read("/shared.txt"), "ours")
      assert.strictEqual(yield* theirs.read("/shared.txt"), "theirs")
      assert.deepStrictEqual(base.conflicts, [])
      assert.strictEqual(yield* base.read("/shared.txt"), "v0")
    }))

  it.effect("should take a removed directory's subtree as a whole when its conflict is resolved", () =>
    Effect.gen(function*() {
      const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake) {
        return yield* merge(remove("/dir"), all(create("/dir/new.txt", "theirs"), create("/other.txt", "t")), {
          resolutions: yield* resolutions([["/dir/new.txt", take]])
        })
      })

      const ours = yield* resolve("ours")
      const theirs = yield* resolve("theirs")

      assert.deepStrictEqual(ours.changes, [
        "Removed /dir:directory",
        "Removed /dir/inner.txt:file",
        "Added /other.txt:file"
      ])
      assert.deepStrictEqual(theirs.changes, ["Added /dir/new.txt:file", "Added /other.txt:file"])
      assert.strictEqual(yield* theirs.read("/dir/inner.txt"), "inner")
    }))

  it.effect("should reject a resolution for a path that is not in conflict", () =>
    Effect.gen(function*() {
      const failure = yield* Effect.flip(
        merge(write("/shared.txt", "ours"), create("/new.txt", "t"), {
          resolutions: yield* resolutions([["/new.txt", "ours"]])
        })
      )

      assert.instanceOf(failure, Vfs.VfsError)
      assert.deepStrictEqual([failure.code, failure.field], ["InvalidArgument", "resolutions"])
    }))

  it.effect("should reject resolutions that split one hard-link group between sides", () =>
    Effect.gen(function*() {
      const partial = yield* Effect.flip(
        merge(link("/g1", "/g3"), remove("/g2"), {
          resolutions: yield* resolutions([["/g1", "ours"]])
        })
      )

      const split = yield* Effect.flip(
        merge(link("/g1", "/g3"), remove("/g2"), {
          resolutions: yield* resolutions([["/g1", "ours"], ["/g2", "theirs"], ["/g3", "ours"]])
        })
      )

      assert.instanceOf(partial, Vfs.VfsError)
      assert.instanceOf(split, Vfs.VfsError)
      assert.deepStrictEqual([partial.code, split.code], ["InvalidArgument", "InvalidArgument"])
    }))

  it.effect("should take one side of a hard-link group when every path resolves the same way", () =>
    Effect.gen(function*() {
      const outcome = yield* merge(link("/g1", "/g3"), remove("/g2"), {
        resolutions: yield* resolutions([["/g1", "theirs"], ["/g2", "theirs"], ["/g3", "theirs"]])
      })

      assert.deepStrictEqual(outcome.changes, ["Updated /g1 file->file [hardLinks]", "Removed /g2:file"])
    }))

  for (const row of linkRows) {
    it.effect(`should ${row.name}`, () =>
      Effect.gen(function*() {
        const outcome = yield* merge(row.ours, row.theirs, undefined, linkFixture)

        assert.deepStrictEqual(outcome.changes, row.changes)
        assert.deepStrictEqual(outcome.conflicts, row.conflicts)
      }))
  }

  it.effect("should write the other side's bytes through a new first-sorting link name", () =>
    Effect.gen(function*() {
      const outcome = yield* merge(link("/h", "/0"), write("/h", "t"), undefined, linkFixture)

      assert.strictEqual(yield* outcome.read("/0"), "t")
      assert.strictEqual(yield* outcome.read("/dir/l"), "t")
      assert.strictEqual((yield* outcome.stat("/0")).nlink, 3)
    }))

  it.effect("should leave a target node alone when a name pointed at it is in conflict", () =>
    Effect.gen(function*() {
      const outcome = yield* merge(point("/a", "/b"), write("/a", "t"), undefined, linkFixture)

      assert.strictEqual(yield* outcome.read("/a"), "a")
      assert.strictEqual(yield* outcome.read("/b"), "b")
      assert.strictEqual((yield* outcome.stat("/b")).nlink, 1)
    }))

  it.effect("should keep a linked node intact when the directory above one name is in conflict", () =>
    Effect.gen(function*() {
      const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake | undefined) {
        return yield* merge(remove("/dir"), chmod("/dir/inner.txt", 0o600), {
          resolutions: take === undefined ? [] : yield* resolutions([["/dir/inner.txt", take], ["/h", take]])
        }, linkFixture)
      })

      const open = yield* resolve(undefined)
      const base = yield* resolve("base")
      const theirs = yield* resolve("theirs")
      const ours = yield* resolve("ours")

      assert.strictEqual((yield* open.stat("/h")).nlink, 2)
      assert.deepStrictEqual(base.changes, [])
      assert.strictEqual((yield* base.stat("/h")).nlink, 2)
      assert.deepStrictEqual(theirs.changes, ["Updated /dir/inner.txt file->file [mode]"])
      assert.strictEqual((yield* theirs.stat("/h")).nlink, 2)
      assert.deepStrictEqual(ours.changes, [
        "Removed /dir:directory",
        "Removed /dir/inner.txt:file",
        "Removed /dir/l:file",
        "Updated /h file->file [hardLinks]"
      ])
      assert.strictEqual((yield* ours.stat("/h")).nlink, 1)
    }))

  it.effect("should take one side of a diverged group whole, including a replaced name", () =>
    Effect.gen(function*() {
      const resolve = Effect.fnUntraced(function*(take: Vfs.MergeTake) {
        return yield* merge(all(remove("/t1"), mkdir("/t1")), link("/t2", "/t4"), {
          resolutions: yield* resolutions([["/t1", take], ["/t2", take], ["/t3", take], ["/t4", take]])
        }, linkFixture)
      })

      const ours = yield* resolve("ours")
      const theirs = yield* resolve("theirs")

      assert.deepStrictEqual(ours.conflicts, [])
      assert.deepStrictEqual(ours.changes, [
        "Updated /t1 file->directory [kind,hardLinks,mode]",
        "Updated /t2 file->file [hardLinks]",
        "Updated /t3 file->file [hardLinks]"
      ])
      assert.strictEqual((yield* ours.stat("/t2")).nlink, 2)
      assert.deepStrictEqual(theirs.changes, [
        "Updated /t1 file->file [hardLinks]",
        "Updated /t2 file->file [hardLinks]",
        "Updated /t3 file->file [hardLinks]",
        "Added /t4:file"
      ])
      assert.strictEqual((yield* theirs.stat("/t4")).nlink, 4)
    }))

  it.effect("should keep a timestamp-only change beside the other side's metadata change", () =>
    Effect.gen(function*() {
      const outcome = yield* merge(chmod("/shared.txt", 0o600), touch("/shared.txt", 7_000n))

      assert.deepStrictEqual(outcome.conflicts, [])
      const stat = yield* outcome.stat("/shared.txt")
      assert.strictEqual(stat.mtimeNs, 7_000n)
      assert.strictEqual(stat.mode & 0o777, 0o600)
    }))

  it.effect("should reject malformed options with InvalidArgument", () =>
    Effect.gen(function*() {
      const base = yield* (yield* fixture).snapshot
      const delta = yield* deltaOf(base, none)

      // Options arrive from a boundary as untyped data here, so the operation's own decoding has to reject them.
      // SAFETY: the parsed value is deliberately outside the option type; the test asserts the rejection.
      // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- see the invariant above.
      const malformed = (yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        "{\"resolutions\":{}}"
      )) as Vfs.MergeOptions

      const bogus = yield* Effect.flip(Vfs.mergeSnapshotDeltas(base, delta, delta, malformed))

      assert.instanceOf(bogus, Vfs.VfsError)
      assert.deepStrictEqual([bogus.code, bogus.field], ["InvalidArgument", "resolutions"])
    }))

  it.effect("should reject a delta from another base", () =>
    Effect.gen(function*() {
      const base = yield* (yield* fixture).snapshot
      const otherBase = yield* (yield* Vfs.fromFixture({ entries: [] })).snapshot

      const failure = yield* Effect.flip(
        Vfs.mergeSnapshotDeltas(base, yield* deltaOf(base, none), yield* deltaOf(otherBase, none))
      )

      assert.instanceOf(failure, Vfs.VfsError)
      assert.deepStrictEqual([failure.code, failure.operation], ["BaseMismatch", "mergeSnapshotDeltas"])
    }))
})

// Property tests draw two edit scripts over a small set of paths and check the merge laws on their deltas.
const Path = Schema.Literals(["/0", "/a", "/b", "/dir", "/dir/x", "/dir/y", "/g1", "/g2", "/g3", "/s"])

const Step = Schema.Union([
  Schema.TaggedStruct("Write", { path: Path, value: Schema.Literals(["one", "two"]) }),
  Schema.TaggedStruct("Remove", { path: Path }),
  Schema.TaggedStruct("Chmod", { path: Path, mode: Schema.Literals([0o600, 0o644, 0o755]) }),
  Schema.TaggedStruct("Mkdir", { path: Path }),
  Schema.TaggedStruct("Link", { from: Path, to: Path }),
  Schema.TaggedStruct("Rename", { from: Path, to: Path }),
  Schema.TaggedStruct("Symlink", { path: Path, target: Schema.Literals(["a", "dir"]) }),
  Schema.TaggedStruct("Touch", { path: Path, nanoseconds: Schema.Literals([1_000n, 2_000n]) })
])

type Step = typeof Step.Type

const Script = Schema.Array(Step).check(Schema.isMaxLength(7))

// Each law runs with a fixed seed so CI is reproducible; a failure prints the replay token of its exact case.
const law = (seed: number) => ({ arbitrary: { runs: 150, seed } })

const propertyFixture = Vfs.fromFixture({
  entries: [
    { kind: "file", path: "/a", bytes: text("a") },
    { kind: "file", path: "/b", bytes: text("b") },
    { kind: "directory", path: "/dir" },
    { kind: "file", path: "/dir/x", bytes: text("x") },
    { kind: "hardLink", path: "/dir/y", target: "/b" },
    { kind: "file", path: "/g1", bytes: text("g") },
    { kind: "hardLink", path: "/g2", target: "/g1" },
    { kind: "hardLink", path: "/g3", target: "/g1" },
    { kind: "symlink", path: "/s", target: "a" }
  ]
})

// Steps that do not apply to the current tree are skipped, so every script yields a valid side.
const stepEdit = Match.type<Step>().pipe(
  Match.tag("Write", (step) => write(step.path, step.value)),
  Match.tag("Remove", (step) => remove(step.path)),
  Match.tag("Chmod", (step) => chmod(step.path, step.mode)),
  Match.tag("Mkdir", (step) => mkdir(step.path)),
  Match.tag("Link", (step) => link(step.from, step.to)),
  Match.tag("Rename", (step) => rename(step.from, step.to)),
  Match.tag("Symlink", (step): Edit => (fs) => fs.symlink(step.target, step.path)),
  Match.tag("Touch", (step) => touch(step.path, step.nanoseconds)),
  Match.exhaustive
)

const run = (script: ReadonlyArray<Step>): Edit => (fs) =>
  Effect.forEach(script, (step) => Effect.ignore(stepEdit(step)(fs)))

const encodeDelta = Schema.encodeEffect(Vfs.SnapshotDeltaFromBytes())

const sameDelta = Effect.fnUntraced(function*(left: Vfs.SnapshotDelta, right: Vfs.SnapshotDelta) {
  assert.deepStrictEqual(yield* encodeDelta(left), yield* encodeDelta(right))
})

const swapped = (conflict: Vfs.MergeConflict): Vfs.MergeConflict => ({
  path: conflict.path,
  reason: conflict.reason,
  ours: conflict.theirs,
  theirs: conflict.ours
})

it.layer(BunCrypto.layer)("snapshot delta merge laws", (it) => {
  const inspected = (base: Vfs.Snapshot, delta: Vfs.SnapshotDelta) =>
    Vfs.inspectSnapshotDelta(base, delta, { includeTimestamps: true }).pipe(
      Effect.map((changes) => new Map(changes.map((change) => [pathText(change.path), render(change)])))
    )

  it.effect.prop(
    "should return a delta unchanged when merged with an empty delta",
    { script: Script },
    ({ script }) =>
      Effect.gen(function*() {
        const base = yield* (yield* propertyFixture).snapshot
        const delta = yield* deltaOf(base, run(script))
        const empty = yield* deltaOf(base, none)
        const left = yield* Vfs.mergeSnapshotDeltas(base, delta, empty)
        const right = yield* Vfs.mergeSnapshotDeltas(base, empty, delta)

        assert.deepStrictEqual(left.conflicts, [])
        assert.deepStrictEqual(right.conflicts, [])
        yield* sameDelta(left.delta, delta)
        yield* sameDelta(right.delta, delta)
      }),
    law(1)
  )

  it.effect.prop(
    "should return a delta unchanged when merged with itself",
    { script: Script },
    ({ script }) =>
      Effect.gen(function*() {
        const base = yield* (yield* propertyFixture).snapshot
        const delta = yield* deltaOf(base, run(script))
        const result = yield* Vfs.mergeSnapshotDeltas(base, delta, delta)

        assert.deepStrictEqual(result.conflicts, [])
        yield* sameDelta(result.delta, delta)
      }),
    law(2)
  )

  it.effect.prop(
    "should mirror the result when the sides are swapped",
    { ours: Script, theirs: Script },
    ({ ours, theirs }) =>
      Effect.gen(function*() {
        const base = yield* (yield* propertyFixture).snapshot
        const o = yield* deltaOf(base, run(ours))
        const t = yield* deltaOf(base, run(theirs))
        const forward = yield* Vfs.mergeSnapshotDeltas(base, o, t)
        const backward = yield* Vfs.mergeSnapshotDeltas(base, t, o)

        yield* sameDelta(forward.delta, backward.delta)
        assert.deepStrictEqual(
          forward.conflicts.map(renderConflict),
          backward.conflicts.map(swapped).map(renderConflict)
        )
      }),
    law(3)
  )

  it.effect.prop(
    "should apply cleanly and report nothing once every conflict takes one side",
    { ours: Script, theirs: Script },
    ({ ours, theirs }) =>
      Effect.gen(function*() {
        const base = yield* (yield* propertyFixture).snapshot
        const o = yield* deltaOf(base, run(ours))
        const t = yield* deltaOf(base, run(theirs))
        const first = yield* Vfs.mergeSnapshotDeltas(base, o, t)

        for (const take of ["ours", "theirs", "base"] as const) {
          const resolutions = first.conflicts.map((conflict) => ({ path: conflict.path, take }))
          const second = yield* Vfs.mergeSnapshotDeltas(base, o, t, { resolutions })

          assert.deepStrictEqual(second.conflicts, [])
          yield* Vfs.applySnapshotDelta(base, second.delta)
        }
      }),
    law(4)
  )

  it.effect.prop(
    "should take a path only one side changed exactly as that side left it when nothing conflicts",
    { ours: Script, theirs: Script },
    ({ ours, theirs }) =>
      Effect.gen(function*() {
        const base = yield* (yield* propertyFixture).snapshot
        const o = yield* deltaOf(base, run(ours))
        const t = yield* deltaOf(base, run(theirs))
        const result = yield* Vfs.mergeSnapshotDeltas(base, o, t)

        if (result.conflicts.length > 0) return
        const oursChanges = yield* inspected(base, o)
        const theirsChanges = yield* inspected(base, t)
        const merged = yield* inspected(base, result.delta)

        // A hard-linked name's group can still change through the other side, so compare names outside any group.
        const grouped = new Set(["/b", "/dir/y", "/g1", "/g2", "/g3"])

        for (const [path, change] of oursChanges) {
          if (!theirsChanges.has(path) && !grouped.has(path)) assert.strictEqual(merged.get(path), change, path)
        }

        for (const [path, change] of theirsChanges) {
          if (!oursChanges.has(path) && !grouped.has(path)) assert.strictEqual(merged.get(path), change, path)
        }
      }),
    law(5)
  )

  it.effect.prop(
    "should leave every conflicted path at base and write nothing outside both sides' paths",
    { ours: Script, theirs: Script },
    ({ ours, theirs }) =>
      Effect.gen(function*() {
        const base = yield* (yield* propertyFixture).snapshot
        const o = yield* deltaOf(base, run(ours))
        const t = yield* deltaOf(base, run(theirs))
        const result = yield* Vfs.mergeSnapshotDeltas(base, o, t)
        const union = new Set([...(yield* inspected(base, o)).keys(), ...(yield* inspected(base, t)).keys()])
        const merged = yield* inspected(base, result.delta)

        for (const conflict of result.conflicts) {
          assert.isFalse(merged.has(pathText(conflict.path)), pathText(conflict.path))
        }

        for (const path of merged.keys()) assert.isTrue(union.has(path), path)
      }),
    law(6)
  )
})
