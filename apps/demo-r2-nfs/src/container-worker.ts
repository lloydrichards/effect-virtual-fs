import { Container } from "@cloudflare/containers"

interface Env {
  R2_NFS_CONTAINER: DurableObjectNamespace<R2NfsContainer>
  R2_ENDPOINT: string
  R2_BUCKET: string
  R2_IMAGE_KEY: string
  R2_ACCESS_KEY_ID: string
  R2_SECRET_ACCESS_KEY: string
  DEMO_TOKEN: string
  NFS_MOUNT_READ_ONLY?: string
}

export class R2NfsContainer extends Container<Env> {
  override defaultPort = 8080
  override sleepAfter = "10m"
  override envVars = {
    R2_ENDPOINT: this.env.R2_ENDPOINT,
    R2_BUCKET: this.env.R2_BUCKET,
    R2_IMAGE_KEY: this.env.R2_IMAGE_KEY,
    R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
    NFS_MOUNT_READ_ONLY: this.env.NFS_MOUNT_READ_ONLY ?? "0"
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (!env.DEMO_TOKEN) return Promise.resolve(new Response("Demo token is not configured", { status: 503 }))

    if (request.headers.get("Authorization") !== `Bearer ${env.DEMO_TOKEN}`) {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }))
    }

    // A fixed name keeps one container attached to the single-owner R2 image.
    return env.R2_NFS_CONTAINER.getByName("r2-nfs-demo").fetch(request)
  }
}
