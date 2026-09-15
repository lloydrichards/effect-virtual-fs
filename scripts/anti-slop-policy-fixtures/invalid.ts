declare const value: { readonly _tag: "First" | "Second" | "Third" }

interface ResponseShape {
  readonly value: string
}

const label = value._tag === "First" ? "one" : value._tag === "Second" ? "two" : "three"
const result = { _tag: "Success", value: 1 }

export { label, type ResponseShape, result }
