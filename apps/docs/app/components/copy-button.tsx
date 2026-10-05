"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "~/lib/utils"

interface CopyButtonProps {
  getValue: () => string
  className?: string
}

export function CopyButton({ getValue, className }: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle")
  const copied = status === "copied"
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null)

  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
  }, [])

  const handleCopy = useCallback(() => {
    setStatus("idle")

    if (timeoutRef.current) clearTimeout(timeoutRef.current)

    if (!navigator.clipboard) {
      setStatus("failed")

      return
    }

    void navigator.clipboard.writeText(getValue()).then(() => {
      setStatus("copied")
      timeoutRef.current = setTimeout(() => setStatus("idle"), 2000)
    }).catch(() => {
      setStatus("failed")
    })
  }, [getValue])

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          "absolute top-2 right-2 flex size-11 items-center justify-center rounded-md text-code-block-foreground/60 transition-[color,background-color,opacity] duration-150 motion-reduce:transition-none hover:bg-background/70 hover:text-code-block-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:top-3 md:right-3 md:size-8",
          className
        )}
        aria-label={copied ? "Copied" : "Copy code"}
      >
        {copied ?
          (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) :
          (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
      </button>
      <div
        className={status === "failed" ? "mt-2 break-words text-sm text-foreground" : "sr-only"}
        role="status"
      >
        {status === "failed"
          ? "Could not copy code. Select the code and copy it manually."
          : status === "copied"
          ? "Code copied."
          : ""}
      </div>
    </>
  )
}
