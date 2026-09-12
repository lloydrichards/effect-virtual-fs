import { apiPages } from "./api-pages"
import { contentPages } from "./content-pages"

export type NavItem = { readonly label: string; readonly href: string }
export type NavSection = { readonly title: string; readonly items: ReadonlyArray<NavItem> }

export const navigation: ReadonlyArray<NavSection> = [
  ...contentPages.map(({ section, label, href }) => ({ title: section, items: [{ label, href }] })),
  {
    title: "API Reference",
    items: apiPages.map(({ label, href }) => ({ label, href }))
  }
]
