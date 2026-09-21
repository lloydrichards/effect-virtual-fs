import * as Cloudflare from "alchemy/Cloudflare"

export const imageBucket = Cloudflare.R2.Bucket("NotebookImages")
