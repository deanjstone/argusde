import * as React from "react";
import { cn } from "../../lib/utils.js";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus-visible:border-violet-500 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
