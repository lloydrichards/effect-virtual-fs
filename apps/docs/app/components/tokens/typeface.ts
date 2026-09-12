import { cn } from "~/lib/utils"

/**
 * Compact documentation type scale with a sans-serif display face.
 * Monospace is reserved for code and technical values.
 */

export const typefaceHeading1 = (className?: string) =>
  cn(
    "font-heading text-[2.125rem] sm:text-[2.75rem] font-semibold tracking-[-0.035em] leading-[1.1]",
    className
  )

export const typefaceHeading2 = (className?: string) =>
  cn(
    "font-heading text-[1.75rem] sm:text-[2rem] font-semibold tracking-[-0.035em] leading-[1.15]",
    className
  )

export const typefaceHeading3 = (className?: string) =>
  cn(
    "font-heading text-[1.4rem] font-semibold tracking-[-0.025em] leading-[1.25]",
    className
  )

export const typefaceHeading4 = (className?: string) =>
  cn(
    "font-heading text-[1.2rem] font-semibold tracking-[-0.02em] leading-[1.35]",
    className
  )

export const typefaceHeading5 = (className?: string) =>
  cn(
    "font-heading text-[1.05rem] font-semibold tracking-[-0.012em] leading-[1.4]",
    className
  )

export const typefaceHeading6 = (className?: string) =>
  cn(
    "font-heading text-base font-semibold tracking-[-0.01em] leading-[1.4]",
    className
  )

export const typefaceBody = (className?: string) =>
  cn("font-sans text-[1.025rem] leading-[1.75] tracking-normal", className)

export const typefaceMeta = (className?: string) =>
  cn(
    "font-sans text-[0.8125rem] font-medium leading-[1.5] tracking-[0.01em]",
    className
  )

export const typefaceAnchor = (className?: string) =>
  cn(
    "font-medium underline decoration-primary/40 underline-offset-[3px] hover:decoration-primary transition-colors duration-150",
    className
  )
