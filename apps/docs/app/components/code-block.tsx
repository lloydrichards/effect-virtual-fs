"use client"

import { useCallback, useRef } from "react"
import { CopyButton } from "~/components/copy-button"
import { cn } from "~/lib/utils"

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children: React.ReactNode
}

export function CodeBlock({ className, children, ...props }: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null)

  const getValue = useCallback(() => {
    if (!preRef.current) return ""
    return preRef.current.textContent ?? ""
  }, [])

  return (
    <div className="group relative mb-4 min-w-0 max-w-full">
      <pre
        ref={preRef}
        className={cn(
          "max-w-full overflow-x-auto rounded-xl border border-code-block-border bg-code-block p-4 font-mono text-code-block-foreground text-sm shadow-sm shadow-foreground/[0.03]",
          className
        )}
        {...props}
      >
        {children}
      </pre>
      <CopyButton
        getValue={getValue}
        className="opacity-0 group-hover:opacity-100"
      />
    </div>
  )
}
