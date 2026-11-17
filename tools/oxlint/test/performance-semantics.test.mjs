import { expect, test } from "bun:test"

test("concatenating to a one-element slice keeps a two-element window", () => {
  const window = [1, 2, 3].reduce((acc, value) => acc.slice(-1).concat(value), [])

  expect(window).toEqual([2, 3])
})

test("array iterators visit sparse slots that eager map and filter skip", () => {
  const values = []

  values[1] = 1

  const eager = values.map(String).filter(Boolean)
  const lazy = values.values().map(String).filter(Boolean).toArray()

  expect(eager).toEqual(["1"])
  expect(lazy).toEqual(["undefined", "1"])
})

test("eager array callbacks run in stages and expose each stage's input", () => {
  const values = [1, 2, 3]
  const calls = []

  const keep = (value, index, input) => {
    calls.push(["filter", index, input])

    return value !== 2
  }

  const transform = (value, index, input) => {
    calls.push(["map", index, input])

    return value * 10
  }

  expect(values.filter(keep).map(transform)).toEqual([10, 30])
  expect(calls).toEqual([
    ["filter", 0, [1, 2, 3]],
    ["filter", 1, [1, 2, 3]],
    ["filter", 2, [1, 2, 3]],
    ["map", 0, [1, 3]],
    ["map", 1, [1, 3]]
  ])

  calls.length = 0
  expect(values.values().filter(keep).map(transform).toArray()).toEqual([10, 30])
  expect(calls).toEqual([
    ["filter", 0, undefined],
    ["map", 0, undefined],
    ["filter", 1, undefined],
    ["filter", 2, undefined],
    ["map", 1, undefined]
  ])
})

test("Reflect.get forwards the actual receiver through a proxy", () => {
  const target = {
    label: "target",
    get name() {
      return this.label
    }
  }

  const proxy = new Proxy(target, {
    get(target, key, receiver) {
      return Reflect.get(target, key, receiver)
    }
  })

  const receiver = Object.create(proxy)
  receiver.label = "receiver"

  expect(receiver.name).toBe("receiver")
  expect(target.name).toBe("target")
})
