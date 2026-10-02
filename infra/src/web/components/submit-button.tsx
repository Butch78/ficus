"use client";

/**
 * A server action form's submit button that shows the action is running:
 * a spinner, the pending label, and no second submit until it answers.
 * A plant imports a whole repository, which can take a minute.
 */
import { Button } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

interface Props {
  readonly children: ReactNode;
  /** What the button says while the action runs. */
  readonly pending: ReactNode;
  /** Primary for the step forward; secondary-destructive for withdrawing something. */
  readonly variant?: "primary" | "secondary" | "secondary-destructive";
}

export function SubmitButton({ children, pending: pendingLabel, variant = "primary" }: Props) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant={variant} loading={pending} disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
