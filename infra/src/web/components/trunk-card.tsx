import type { ReactNode } from "react";
import { FlowNode } from "./kumo.ts";

/** Turns a box upside down; the trunk's flow wears it, and each card wears it again to read the right way up. */
export const FLIP = "-scale-y-100";

/** One step of the trunk, turned the right way up: as wide as its column, or a share of it when cards stand side by side. */
export function Card({ children, share = 1 }: { readonly children: ReactNode; readonly share?: number }) {
  const width = share === 1 ? undefined : { width: `calc(${100 / share}cqw - 2.5rem)` };

  return (
    <FlowNode>
      <div className={`${FLIP} flex w-[calc(100cqw-2.5rem)] min-w-0 flex-col gap-1 text-left [overflow-wrap:anywhere]`} style={width}>
        {children}
      </div>
    </FlowNode>
  );
}
