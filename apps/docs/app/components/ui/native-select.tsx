import { ChevronDown } from "lucide-react"
import type { ComponentProps } from "react"

export function NativeSelect(props: ComponentProps<"select">) {
  return (
    <span className="relative inline-flex">
      <select
        data-slot="native-select"
        className="h-8 appearance-none rounded-md border border-input bg-background ps-2.5 pe-7 text-xs text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute end-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  )
}
