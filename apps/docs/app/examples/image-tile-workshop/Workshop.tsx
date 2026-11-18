import { RegistryProvider } from "@effect/atom-react"
import { App } from "./App.tsx"
import "./style.css"

export default function ImageTileWorkshop() {
  return (
    <div className="image-tile-workshop-page">
      <RegistryProvider>
        <App />
      </RegistryProvider>
    </div>
  )
}
