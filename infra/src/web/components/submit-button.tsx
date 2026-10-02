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
}

export function SubmitButton({ children, pending: pendingLabel }: Props) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="primary" loading={pending} disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
