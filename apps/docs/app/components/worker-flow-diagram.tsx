import { ArrowDown, ArrowRight } from "lucide-react"

export function WorkerFlowDiagram({ label, steps }: {
  readonly label: string
  readonly steps: ReadonlyArray<readonly [title: string, detail: string]>
}) {
  return (
    <figure className="my-5 rounded-xl border bg-muted/30 p-4">
      <figcaption className="mb-3 text-sm font-semibold">{label}</figcaption>
      <ol className="grid gap-2 md:flex md:items-stretch">
        {steps.map(([title, detail], index) => (
          <li key={title} className="contents">
            {index > 0 && (
              <>
                <ArrowDown aria-hidden="true" className="mx-auto size-4 text-muted-foreground md:hidden" />
                <ArrowRight
                  aria-hidden="true"
                  className="hidden size-4 shrink-0 self-center text-muted-foreground md:block"
                />
              </>
            )}
            <div className="min-w-0 flex-1 rounded-md border bg-card p-3">
              <strong className="block text-sm">{title}</strong>
              <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>
            </div>
          </li>
        ))}
      </ol>
    </figure>
  )
}
