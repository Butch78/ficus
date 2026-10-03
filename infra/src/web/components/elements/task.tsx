"use client";

/**
 * Task, from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/task.tsx; Copyright 2023 Vercel, Inc., Apache
 * License 2.0). Changed for Ficus: Kumo's Collapsible and semantic tokens in
 * place of shadcn/ui's, Phosphor icons in place of lucide, and a trigger that
 * takes a status icon and a trailing detail, so a task reads like an agent's
 * tool call: what, whether it worked, how long.
 */
import { Collapsible, cn } from "@cloudflare/kumo";
import { CaretDownIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";

export type TaskProps = ComponentProps<typeof Collapsible.Root>;

export function Task({ defaultOpen = true, className, ...props }: TaskProps) {
  return <Collapsible.Root className={cn("w-full", className)} defaultOpen={defaultOpen} {...props} />;
}

export interface TaskTriggerProps {
  readonly title: ReactNode;
  readonly icon?: ReactNode;
  /** After the title, quieter: a duration, a count, why it is waiting. */
  readonly detail?: ReactNode;
}

export function TaskTrigger({ title, icon, detail }: TaskTriggerProps) {
  return (
    <Collapsible.Trigger className="group flex w-full cursor-pointer items-center gap-2 text-sm text-kumo-default">
      {icon}
      <span className="font-medium">{title}</span>
      {detail === undefined ? null : <span className="text-kumo-subtle">· {detail}</span>}
      <CaretDownIcon size={14} className="text-kumo-subtle transition-transform group-data-[panel-open]:rotate-180" />
    </Collapsible.Trigger>
  );
}

export function TaskContent({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Collapsible.Panel>
      <div className={cn("mt-3 flex flex-col gap-2 border-l-2 border-kumo-hairline pl-4", className)}>{children}</div>
    </Collapsible.Panel>
  );
}

export function TaskItem({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return <div className={cn("text-sm text-kumo-subtle", className)}>{children}</div>;
}
