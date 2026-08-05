import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

export interface DropdownItem {
  label: string;
  onClick?: () => void;
  variant?: "default" | "danger";
  subMenuItems?: DropdownItem[];
  disabled?: boolean;
}

export interface DropdownProps {
  trigger: React.ReactNode;
  items: DropdownItem[];
  align?: "left" | "right";
  className?: string;
}

export function Dropdown({ trigger, items, align = "right", className }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close when clicked outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative inline-block text-left" ref={dropdownRef}>
      <div onClick={() => setIsOpen(!isOpen)} className="cursor-pointer">
        {trigger}
      </div>

      {isOpen && (
        <div
          className={cn(
            "absolute z-50 mt-1 w-44 bg-surface-card border border-border-primary rounded-sm shadow-md",
            align === "right" ? "right-0" : "left-0",
            className
          )}
        >
          <div className="flex flex-col divide-y divide-border-secondary">
            {items.map((item, idx) => (
              <DropdownRow key={idx} item={item} setIsOpen={setIsOpen} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DropdownRow({ item, setIsOpen }: { item: DropdownItem; setIsOpen: (open: boolean) => void }) {
  const [isSubOpen, setIsSubOpen] = useState(false);
  const hasSubMenu = !!(item.subMenuItems && item.subMenuItems.length > 0);

  return (
    <div
      className="relative w-full"
      onMouseEnter={() => hasSubMenu && !item.disabled && setIsSubOpen(true)}
      onMouseLeave={() => hasSubMenu && setIsSubOpen(false)}
    >
      <button
        disabled={item.disabled}
        onClick={(e) => {
          if (item.disabled) return;
          if (hasSubMenu) {
            e.stopPropagation();
            setIsSubOpen(!isSubOpen);
          } else if (item.onClick) {
            item.onClick();
            setIsOpen(false);
          }
        }}
        className={cn(
          "w-full text-left px-4 py-2.5 text-xs font-sans font-medium transition-colors hover:bg-surface-muted select-none cursor-pointer flex items-center justify-between",
          item.disabled
            ? "opacity-50 cursor-not-allowed text-text-muted hover:bg-transparent"
            : item.variant === "danger"
              ? "text-red-600 hover:bg-red-500/10"
              : "text-foreground"
        )}
      >
        <span>{item.label}</span>
        {hasSubMenu && (
          <svg className="h-3 w-3 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        )}
      </button>

      {hasSubMenu && isSubOpen && !item.disabled && (
        <div
          className="absolute right-full top-0 mr-1 w-40 bg-surface-card border border-border-primary rounded-sm shadow-lg flex flex-col divide-y divide-border-secondary z-50"
        >
          {item.subMenuItems!.map((subItem, sIdx) => (
            <button
              key={sIdx}
              disabled={subItem.disabled}
              onClick={() => {
                if (subItem.disabled) return;
                if (subItem.onClick) {
                  subItem.onClick();
                }
                setIsOpen(false);
              }}
              className={cn(
                "w-full text-left px-4 py-2.5 text-xs font-sans font-medium transition-colors hover:bg-surface-muted select-none cursor-pointer",
                subItem.disabled
                  ? "opacity-50 cursor-not-allowed text-text-muted hover:bg-transparent"
                  : subItem.variant === "danger"
                    ? "text-red-600 hover:bg-red-500/10"
                    : "text-foreground"
              )}
            >
              {subItem.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
