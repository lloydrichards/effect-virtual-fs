export const workshopPage = "/examples/image-tile-workshop"

export const formerWorkshopPage = workshopPage + "/run"

export function isWorkshopPage(path: string) {
  return path.replace(/[?#].*$/, "").replace(/\/$/, "") === workshopPage
}

export function crossesWorkshopBoundary(from: string, to: string) {
  return isWorkshopPage(from) !== isWorkshopPage(to)
}

export const workshopHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp"
}
