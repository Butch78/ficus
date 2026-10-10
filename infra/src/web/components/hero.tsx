import type { ReactNode } from "react";
import { GrowthBackdrop } from "./growth-shader.tsx";

interface Props {
  /** A line above the title: where the page sits. */
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  /** Beside the title: its badges and switches. */
  readonly aside?: ReactNode;
  /** Under the title: what the page is about, at a glance. */
  readonly children?: ReactNode;
}

/** A page's heading as a banner, with a growth pattern fading in behind its right side. */
export function Hero({ eyebrow, title, aside, children }: Props) {
  return (
    <section className="relative isolate overflow-hidden rounded-xl border border-kumo-hairline bg-kumo-elevated">
      <GrowthBackdrop className="absolute inset-y-0 right-0 -z-10 h-full w-2/3 [mask-image:linear-gradient(to_left,black_25%,transparent)]" />
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
