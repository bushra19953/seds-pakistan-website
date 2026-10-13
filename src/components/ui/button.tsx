import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/90 disabled:hover:bg-primary",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:hover:bg-destructive",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground disabled:hover:bg-background disabled:hover:text-current",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:hover:bg-secondary",
        ghost:
          "hover:bg-accent hover:text-accent-foreground disabled:hover:bg-transparent",
        link:
          "text-primary underline-offset-4 hover:underline disabled:hover:no-underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Spinner() {
  return (
    <svg
      className="h-4 w-4 shrink-0 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  )
}

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button"
    const isDisabled = disabled || loading

    return (
      <Comp
        className={cn(
          buttonVariants({ variant, size, className }),
          loading && "relative"
        )}
        ref={ref}
        {...props}
        // The native disabled attribute is only valid on <button>; for
        // asChild children, aria-disabled carries the semantics.
        disabled={Comp === "button" ? isDisabled : undefined}
        aria-disabled={isDisabled || undefined}
        aria-busy={loading || undefined}
      >
        {loading ? (
          <>
            {/* Keep the label in the layout (invisible) so the button
                holds its width while the spinner is shown. */}
            <span className="invisible inline-flex items-center gap-2">
              {children}
            </span>
            <span className="absolute inset-0 inline-flex items-center justify-center">
              <Spinner />
            </span>
          </>
        ) : (
          children
        )}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
