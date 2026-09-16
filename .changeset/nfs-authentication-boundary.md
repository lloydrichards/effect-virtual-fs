---
"@effect-vfs/nfs": minor
---

Refuse RPCSEC_GSS credentials with `AUTH_TOOWEAK` and accept UNIX-domain socket addresses.

RPCSEC_GSS is a flavor the server recognises but does not implement, so it now answers `AUTH_TOOWEAK` instead of `AUTH_BADCRED`; unknown or malformed flavors keep `AUTH_BADCRED`. `NfsServer.make` accepts a socket bound to a UNIX-domain socket path as a local address alongside loopback TCP. `NfsServerAddress` is now a union of `NfsServerTcpAddress` and `NfsServerUnixAddress`, so code reading `address.host` or `address.port` must narrow on `"path" in address` first.

```ts
const listening = "path" in server.address
  ? server.address.path
  : `${server.address.host}:${String(server.address.port)}`
```
