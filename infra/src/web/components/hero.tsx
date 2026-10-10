import type { ReactNode } from "react";

interface Props {
  /** A line above the title: where the page sits. */
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  /** Beside the title: its badges and switches. */
  readonly aside?: ReactNode;
  /** Under the title: what the page is about, at a glance. */
  readonly children?: ReactNode;
}

/** A page's heading as a banner. */
export function Hero({ eyebrow, title, aside, children }: Props) {
  return (
    <section className="rounded-xl border border-kumo-hairline bg-kumo-elevated">
      <div className="flex flex-col gap-3 p-6 sm:p-8">
        {eyebrow}
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-3xl font-semibold tracking-tight text-kumo-default">{title}</h2>
          {aside}
        </div>
        {children}
      </div>
    </section>
  );
}
