import { Loader, Text } from "@cloudflare/kumo";
import { RootsLoader } from "../../../components/growth-shader.tsx";

/** While an organization's page, or anything under it, is fetched: strands drifting like a ficus's aerial roots. */
export default function Loading() {
  return (
    <section
      aria-busy="true"
      className="relative isolate flex h-72 flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-kumo-hairline bg-kumo-elevated"
    >
      <RootsLoader className="absolute inset-0 -z-10 h-full w-full" />
      <Loader size={20} />
      <Text size="sm">Growing the tree…</Text>
    </section>
  );
}
