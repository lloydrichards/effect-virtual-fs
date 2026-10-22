import { RegistryProvider } from "@effect/atom-react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/manrope/index.css"
import "@fontsource-variable/jetbrains-mono/index.css"
import { App } from "./App.tsx"
import "./style.css"

createRoot(document.getElementById("root")!).render(
  <RegistryProvider>
    <App />
  </RegistryProvider>
)
