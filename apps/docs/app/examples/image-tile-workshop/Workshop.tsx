import { RegistryProvider } from "@effect/atom-react"
import { WorkshopView } from "./WorkshopView.tsx"
import "./style.css"

export default function ImageTileWorkshop() {
  return (
    <div className="image-tile-workshop-page">
      <RegistryProvider>
        <WorkshopView />
      </RegistryProvider>
    </div>
  )
}
