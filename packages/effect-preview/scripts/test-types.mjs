// Resolve the JS compiler from this workspace, not from Bun's shared TSTyche store.
const child = Bun.spawn(["bun", "run", "tstyche", ...process.argv.slice(2)], {
  cwd: new URL("../", import.meta.url).pathname,
  env: { ...process.env, TSTYCHE_TYPESCRIPT_MODULE: import.meta.resolve("typescript-js") },
  stdout: "inherit",
  stderr: "inherit"
})

process.exit(await child.exited)
