import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

const alertVariants = cva(
  "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        destructive:
          "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
))
Alert.displayName = "Alert"

const AlertTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn("mb-1 font-medium leading-none tracking-tight", className)}
    {...props}
  />
))
AlertTitle.displayName = "AlertTitle"

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("text-sm [&_p]:leading-relaxed", className)}
    {...props}
  />
))
AlertDescription.displayName = "AlertDescription"

interface ErrorAlertProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Heading shown above the message. Defaults to a plain-language title. */
  title?: string
  /** Human-readable description of what failed. Never a raw error code. */
  message: string
  /** When provided, renders a retry button in the action slot. */
  onRetry?: () => void
  /** Label for the retry button. Defaults to "Try again". */
  retryLabel?: string
  /** Extra action node rendered next to the retry button. */
  action?: React.ReactNode
}

/**
 * ErrorAlert: a destructive alert that pairs a plain-language message with
 * an optional retry action, so a failed write shows a readable error and a
 * clear way to try again instead of a generic message. Carries role="alert"
 * so screen readers announce it automatically.
 */
const ErrorAlert = React.forwardRef<HTMLDivElement, ErrorAlertProps>(
  (
    {
      className,
      title = "Something went wrong",
      message,
      onRetry,
      retryLabel = "Try again",
      action,
      ...props
    },
    ref
  ) => (
    <Alert
      ref={ref}
      variant="destructive"
      role="alert"
      aria-atomic="true"
      className={className}
      {...props}
    >
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        {(onRetry || action) && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {onRetry && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetry}
              >
                {retryLabel}
              </Button>
            )}
            {action}
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
)
ErrorAlert.displayName = "ErrorAlert"

export { Alert, AlertTitle, AlertDescription, ErrorAlert }
