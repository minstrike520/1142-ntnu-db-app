import React from "react";
import { cn } from "@/lib/utils";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  description?: string;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, description, ...props }, ref) => {
    return (
      <label className={cn(
        "flex items-start gap-3 select-none",
        props.disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
      )}>
        <div className="relative flex items-center h-5">
          <input
            type="checkbox"
            ref={ref}
            className={cn(
              "peer h-4.5 w-4.5 appearance-none rounded-sm border border-border-primary bg-surface-card checked:bg-primary checked:border-primary focus:outline-none transition-colors",
              props.disabled ? "cursor-not-allowed bg-surface-muted" : "cursor-pointer",
              className
            )}
            {...props}
          />
          {/* Checkmark Icon */}
          <svg
            className="absolute left-[2.5px] top-[2.5px] h-3 w-3 pointer-events-none text-white opacity-0 peer-checked:opacity-100 transition-opacity"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="4"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        {(label || description) && (
          <div className="flex flex-col text-sm leading-tight">
            {label && <span className="font-sans font-medium text-foreground">{label}</span>}
            {description && <span className="font-sans text-xs text-text-muted mt-1">{description}</span>}
          </div>
        )}
      </label>
    );
  }
);

Checkbox.displayName = "Checkbox";

export { Checkbox };
