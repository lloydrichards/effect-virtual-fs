import { apiPages } from "./api-pages"

export type NavItem = { readonly label: string; readonly href: string }
export type NavSection = { readonly title: string; readonly items: ReadonlyArray<NavItem> }

export const navigation: ReadonlyArray<NavSection> = [
  {
    title: "API Reference",
    items: apiPages.map(({ label, href }) => ({ label, href }))
  }
]
