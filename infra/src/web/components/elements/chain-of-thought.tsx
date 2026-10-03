"use client";

/**
 * ChainOfThought, from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/chain-of-thought.tsx; Copyright 2023 Vercel, Inc.,
 * Apache License 2.0). Changed for Ficus: Kumo's Collapsible and semantic
 * tokens in place of shadcn/ui's, Phosphor icons in place of lucide, an
 * `error` status beside complete/active/pending, and no image or search
 * result parts.
 */
import { Collapsible, cn } from "@cloudflare/kumo";
import { CaretDownIcon, CheckIcon, CircleIcon, type Icon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";

interface ChainOfThoughtContextValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

const ChainOfThoughtContext = createContext<ChainOfThoughtContextValue | undefined>(undefined);

const useChainOfThought = () => {
  const context = useContext(ChainOfThoughtContext);

  if (context === undefined) {
    throw new Error("ChainOfThought parts must be inside a ChainOfThought");
  }

  return context;
};

export type ChainOfThoughtProps = ComponentProps<"div"> & {
  readonly defaultOpen?: boolean;
};

export function ChainOfThought({ className, defaultOpen = true, children, ...props }: ChainOfThoughtProps) {
  const [open, setOpen] = useState(defaultOpen);
  const value = useMemo(() => ({ open, setOpen }), [open]);

  return (
    <ChainOfThoughtContext.Provider value={value}>
      <div className={cn("flex w-full flex-col gap-3", className)} {...props}>
        {children}
      </div>
    </ChainOfThoughtContext.Provider>
  );
}

export function ChainOfThoughtHeader({ children, icon }: { readonly children: ReactNode; readonly icon?: ReactNode }) {
  const { open, setOpen } = useChainOfThought();

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <Collapsible.Trigger className="flex w-full items-center gap-2 text-sm text-kumo-subtle hover:text-kumo-default">
        {icon}
        <span className="flex-1 text-left">{children}</span>
        <CaretDownIcon size={14} className={cn("transition-transform", open ? "rotate-180" : "rotate-0")} />
      </Collapsible.Trigger>
    </Collapsible.Root>
  );
}

export type StepStatus = "complete" | "active" | "pending" | "error";

const STATUS_STYLES = {
  active: "text-kumo-default",
  complete: "text-kumo-subtle",
  pending: "text-kumo-inactive",
  error: "text-kumo-danger",
} as const satisfies Record<StepStatus, string>;

const STATUS_ICONS = {
  active: CircleIcon,
  complete: CheckIcon,
  pending: CircleIcon,
  error: WarningCircleIcon,
} as const satisfies Record<StepStatus, Icon>;

export type ChainOfThoughtStepProps = ComponentProps<"div"> & {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  /** Shown at the end of the step's line: how long it took, or is taking. */
  readonly aside?: ReactNode;
  readonly status?: StepStatus;
};

export function ChainOfThoughtStep({
  className,
  label,
  description,
  aside,
  status = "complete",
  children,
  ...props
}: ChainOfThoughtStepProps) {
  const StatusIcon = STATUS_ICONS[status];

  return (
    <div className={cn("flex gap-2 text-sm", STATUS_STYLES[status], className)} {...props}>
      <div className="relative mt-0.5 flex flex-col items-center">
        <StatusIcon
          size={16}
          weight={status === "active" ? "duotone" : "regular"}
          className={cn(status === "active" && "animate-pulse", status === "complete" && "text-kumo-success")}
        />
        <div className="mt-1 w-px flex-1 border-l border-kumo-hairline" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pb-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0">{label}</span>
          {aside === undefined ? null : <span className="shrink-0 text-xs text-kumo-subtle">{aside}</span>}
        </div>
        {description === undefined ? null : <div className="text-xs text-kumo-subtle">{description}</div>}
        {children}
      </div>
    </div>
  );
}

export function ChainOfThoughtContent({ className, children }: { readonly className?: string; readonly children: ReactNode }) {
  const { open } = useChainOfThought();

  return (
    <Collapsible.Root open={open}>
      <Collapsible.Panel className={cn("flex flex-col gap-1", className)}>{children}</Collapsible.Panel>
    </Collapsible.Root>
  );
}
