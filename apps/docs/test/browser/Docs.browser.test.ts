import { inject, test } from "vitest"
import { commands } from "vitest/browser"

declare module "vitest" {
  interface ProvidedContext {
    docsUrl: string
  }
}

declare module "vitest/browser" {
  interface BrowserCommands {
    staticPages: (base: string) => Promise<void>
    playground: (base: string) => Promise<void>
    playgroundRecovery: (base: string) => Promise<void>
    workshop: (base: string) => Promise<void>
    workshopRetile: (base: string) => Promise<void>
    workshopTimeout: (base: string) => Promise<void>
    workshopImageFailure: (base: string) => Promise<void>
  }
}

test("smoke: the built docs serve prerendered landing, guide, and API pages", () =>
  commands.staticPages(inject("docsUrl")))

test("smoke: the Playground restores and runs a saved checkpoint", () => commands.playground(inject("docsUrl")))

test("smoke: the Workshop hands off a tile and exports the image", () => commands.workshop(inject("docsUrl")))

test("the Playground can run again after execution times out", () => commands.playgroundRecovery(inject("docsUrl")))

test("the Workshop preserves odd-sized blur output across tile grids", () => commands.workshopRetile(inject("docsUrl")))

test("the Workshop reports an idle render and lets the user try again", () =>
  commands.workshopTimeout(inject("docsUrl")))

test("the Workshop reports when the browser cannot open a canvas", () =>
  commands.workshopImageFailure(inject("docsUrl")))
