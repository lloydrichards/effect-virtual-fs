import { smoke } from "../../.cache/browser/index.js"

if (await smoke() !== "browser bundle") throw new Error("Browser-target bundle returned unexpected filesystem content")
process.stdout.write("Browser-target bundle smoke passed under Node (not a browser runtime test).\n")
