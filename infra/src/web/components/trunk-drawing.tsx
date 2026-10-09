/**
 * The drawing beside each row of the tree page's history: the trunk as a
 * ficus growing upward, the head at the top and the root at the bottom.
 * The trunk is braided and widens toward the root; each node is a ring on it,
 * and its task's attempts grow off the trunk there, the accepted one large and
 * green, the rest smaller by what became of them; the node's deploys are
 * purple rounds on the trunk, the released node's ringed; a graft's outside
 * commit comes down from above into the trunk; the head opens into a crown and
 * the root spreads over the ground. Decorative: the words beside it carry the
 * meaning.
 */
import type { DeployTone } from "../lib/release.ts";
import { deployStatus } from "../lib/release.ts";
import type { NodeStory, Outcome } from "../lib/trunk.ts";
import { attemptChains } from "../lib/trunk-words.ts";

/** The drawing's box: the column it sits in is this wide on a wide screen and two thirds of it on a phone. */
const WIDTH = 96;

const HEIGHT = 80;

const CENTER = WIDTH / 2;

/** Where the node sits on its row, level with the row's first line of words. */
const NODE_Y = 24;

/** The trunk's width at the `index`th row from the head: slim at the head, stout toward the root. */
export const trunkWidth = (index: number, count: number) => 12 + 22 * Math.sqrt(Math.min(index, count - 1) / Math.max(1, count - 1));

/** How much of its row the trunk spans: all of it, below the node (the head), above it (the root), or none (a lone root). */
export type Reach = "full" | "below" | "above" | "none";

export const reach = (story: NodeStory): Reach => {
  if (story.head) {
    return story.parent === null ? "none" : "below";
  }

  return story.parent === null ? "above" : "full";
};

/**
 * An svg is sized by its own box, not by top and bottom, so each reach gives
 * a height; each overlaps its neighbours by a pixel so no seam shows. The node
 * sits 1rem down on a phone and 1.5rem on a wide screen (NODE_Y, scaled).
 */
const REACH_CLASS = {
  full: "-top-px h-[calc(100%+2px)]",
  below: "top-4 h-[calc(100%-1rem+1px)] sm:top-6 sm:h-[calc(100%-1.5rem+1px)]",
  above: "-top-px h-[calc(1rem+1px)] sm:h-[calc(1.5rem+1px)]",
} as const;

interface SegmentProps {
  readonly reach: Reach;
  /** The trunk's width where the row starts and where it ends. */
  readonly top: number;
  readonly bottom: number;
  /** How far the trunk leans through the row: rows alternate, so it sways rather than standing straight. */
  readonly sway: number;
}

/** A curve down through a row from x `top` to x `bottom`, bowed by `sway`. */
const down = (top: number, bottom: number, sway: number) => `M${top} 0 C${top + sway} 33 ${bottom + sway} 66 ${bottom} 100`;

/** The trunk through one row, stretched to the row's height so rows join into one trunk. */
export function TrunkSegment({ reach: span, top, bottom, sway }: SegmentProps) {
  if (span === "none") {
    return null;
  }

  const left = down(CENTER - top / 2, CENTER - bottom / 2, sway);
  const right = down(CENTER + top / 2, CENTER + bottom / 2, sway);
  const outline = `${left} L${CENTER + bottom / 2} 100 C${CENTER + bottom / 2 + sway} 66 ${CENTER + top / 2 + sway} 33 ${CENTER + top / 2} 0 Z`;
  // Two stems twisting round each other once a row: a braided ficus.
  const braid = `${down(CENTER - top / 4, CENTER + bottom / 4, sway)} ${down(CENTER + top / 4, CENTER - bottom / 4, sway)}`;

  return (
    <svg
      className={`pointer-events-none absolute left-0 w-16 sm:w-24 ${REACH_CLASS[span]}`}
      viewBox={`0 0 ${WIDTH} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={outline} className="fill-kumo-badge-neutral" />
      <path d={outline} className="fill-kumo-badge-orange opacity-25" />
      <path d={braid} className="fill-none stroke-kumo-base opacity-40" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      <path d={`${left} ${right}`} className="fill-none stroke-kumo-line" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** How each outcome is drawn: its size, how far it tilts from its place, how far out from the trunk, and its colors. */
interface Look {
  readonly scale: number;
  /** Degrees added to its place's angle: positive turns it down. */
  readonly tilt: number;
  /** The length of its line from the trunk. */
  readonly offset: number;
  readonly className: string;
  readonly dashed: boolean;
}

const LOOK = {
  accepted: { scale: 1.35, tilt: 0, offset: 6, className: "fill-kumo-badge-green stroke-kumo-success", dashed: false },
  lost: { scale: 0.8, tilt: 8, offset: 5, className: "fill-kumo-badge-green stroke-kumo-success opacity-60", dashed: false },
  abandoned: { scale: 0.7, tilt: 50, offset: 5, className: "fill-kumo-badge-orange stroke-kumo-warning opacity-80", dashed: false },
  rebased: { scale: 0.6, tilt: -20, offset: 10, className: "fill-kumo-badge-teal stroke-kumo-badge-teal opacity-80", dashed: false },
  retried: { scale: 0.6, tilt: -20, offset: 10, className: "fill-kumo-badge-teal stroke-kumo-badge-teal opacity-80", dashed: false },
  open: { scale: 0.75, tilt: 0, offset: 6, className: "fill-none stroke-kumo-success", dashed: true },
} as const satisfies Record<Outcome, Look>;

/** An attempt's outline: broad and round, pointing along +x from the origin with a drawn-out tip; and its middle line. */
const OUTLINE = "M0 0 C3 -10 15 -12 23 -4 L28 0 L23 4 C15 12 3 10 0 0 Z";

const MIDLINE = "M1 0 C8 -0.6 16 -0.6 25 0";

/** One attempt's mark at the origin, without its line from the trunk: the key reuses it. */
export function AttemptIcon({ outcome }: { readonly outcome: Outcome }) {
  const look: Look = LOOK[outcome];

  return (
    <g transform={`scale(${look.scale})`}>
      <path d={OUTLINE} className={look.className} strokeWidth={0.8} strokeDasharray={look.dashed ? "2 1.5" : undefined} />
      {outcome === "open" ? null : <path d={MIDLINE} className="fill-none stroke-kumo-base opacity-50" strokeWidth={0.7} />}
    </g>
  );
}

/** Where the attempts grow, in order (the words list any beyond these): side (1 right, -1 left), height on the row, and angle (negative points up). */
const PLACES = [
  [1, 22, -30],
  [-1, 30, -25],
  [1, 52, 10],
  [-1, 56, 15],
  [1, 10, -60],
  [-1, 14, -60],
  [1, 68, 30],
  [-1, 70, 35],
] as const;

interface AttemptMarkProps {
  readonly outcome: Outcome;
  /** Whether the work was rebased or retried before it ended so: a small mark on its line says so. */
  readonly moved: boolean;
  readonly place: number;
  /** The trunk's width at the node. */
  readonly width: number;
}

function AttemptMark({ outcome, moved, place, width }: AttemptMarkProps) {
  const [side, y, angle] = PLACES[place] ?? PLACES[0];
  const look: Look = LOOK[outcome];

  return (
    <g transform={`translate(${CENTER + side * (width / 2 - 1)} ${y}) scale(${side} 1) rotate(${angle + look.tilt})`}>
      <path d={`M0 0 Q${look.offset / 2} -1 ${look.offset} 0`} className="fill-none stroke-kumo-badge-neutral" strokeWidth={1.4} />
      {moved ? (
        <g transform={`translate(${look.offset / 2} -0.5) rotate(-55)`}>
          <AttemptIcon outcome="rebased" />
        </g>
      ) : null}
      <g transform={`translate(${look.offset} 0)`}>
        <AttemptIcon outcome={outcome} />
      </g>
    </g>
  );
}

/** How a deploy is drawn, by how it went. */
const DEPLOY_LOOK = {
  deployed: "fill-kumo-badge-purple stroke-kumo-badge-purple",
  running: "fill-kumo-recessed stroke-kumo-badge-purple",
  failed: "fill-kumo-badge-red stroke-kumo-danger",
  skipped: "fill-none stroke-kumo-badge-neutral",
  unknown: "fill-kumo-badge-purple stroke-kumo-badge-purple opacity-60",
} as const satisfies Record<DeployTone, string>;

const ROUND = "M0 -6 C3.5 -6 6 -2.5 6 1 C6 4.5 3.3 7 0 7 C-3.3 7 -6 4.5 -6 1 C-6 -2.5 -3.5 -6 0 -6 Z";

interface DeployIconProps {
  readonly tone: DeployTone;
  /** Whether the release points at it now: it is ringed. */
  readonly released: boolean;
}

/** One deploy's mark at the origin: the key reuses it. */
export function DeployIcon({ tone, released }: DeployIconProps) {
  return (
    <g>
      <path d={ROUND} className={DEPLOY_LOOK[tone]} strokeWidth={tone === "running" || tone === "skipped" ? 1.6 : 0.8} />
      <circle cx={0} cy={4.6} r={0.9} className="fill-kumo-base opacity-70" />
      {released ? <circle cx={0} cy={0.5} r={9.5} className="fill-none stroke-kumo-badge-purple" strokeWidth={1.5} /> : null}
    </g>
  );
}

/** How many deploys a node shows in its drawing; the words list all of them. */
const DRAWN_DEPLOYS = 3;

interface DeployMarkProps {
  readonly tone: DeployTone;
  readonly released: boolean;
  /** Its place among the node's deploys, newest first: they alternate right and left, outward. */
  readonly place: number;
  readonly width: number;
}

function DeployMark({ tone, released, place, width }: DeployMarkProps) {
  const side = place % 2 === 0 ? 1 : -1;
  const x = CENTER + side * (width / 2 + 8 + 13 * Math.floor(place / 2));
  const y = 41;

  return (
    <g>
      <path d={`M${CENTER + (side * width) / 2} 32 Q${x} 31 ${x} ${y - 6}`} className="fill-none stroke-kumo-badge-neutral" strokeWidth={1.2} />
      <g transform={`translate(${x} ${y})`}>
        <DeployIcon tone={tone} released={released} />
      </g>
    </g>
  );
}

/**
 * The node's deploys as drawn, newest first; the newest is ringed when the
 * node is released. A released node whose deploys are not known (to a
 * visitor, or on a stage without deploys) still gets one, ringed, but of
 * unknown outcome: the drawing does not claim it deployed.
 */
export const deployMarks = (story: NodeStory): ReadonlyArray<Omit<DeployMarkProps, "width">> => {
  const tones = story.deploys.slice(0, DRAWN_DEPLOYS).map((deploy) => deployStatus(deploy).tone);
  const drawn: ReadonlyArray<DeployTone> = tones.length === 0 && story.released ? ["unknown"] : tones;

  return drawn.map((tone, place) => ({ tone, released: story.released && place === 0, place }));
};

/** The ring on the trunk where the node is. */
function NodeRing({ width }: { readonly width: number }) {
  return (
    <g>
      <ellipse cx={CENTER} cy={NODE_Y} rx={width / 2 + 1.5} ry={3} className="fill-kumo-badge-neutral" />
      <ellipse cx={CENTER} cy={NODE_Y} rx={width / 2 + 1.5} ry={3} className="fill-kumo-badge-orange stroke-kumo-line opacity-40" strokeWidth={0.8} />
      <path d={`M${CENTER - width / 2 + 2} ${NODE_Y + 0.5} Q${CENTER} ${NODE_Y + 3} ${CENTER + width / 2 - 2} ${NODE_Y + 0.5}`} className="fill-none stroke-kumo-line" strokeWidth={0.8} />
    </g>
  );
}

/** The head's crown, as angles (negative points up) and sizes: new growth fanning out above the newest node. */
const CROWN = [
  [-165, 0.95],
  [-128, 1.15],
  [-96, 1.05],
  [-62, 1.2],
  [-22, 0.9],
] as const;

/** The head: the trunk opens into a crown of new growth, with a rolled tip at its middle. */
function HeadCrown({ width }: { readonly width: number }) {
  const top = NODE_Y - 2;

  return (
    <g>
      {CROWN.map(([angle, size], index) => (
        <g key={angle} transform={`translate(${CENTER} ${top}) rotate(${angle}) scale(${size})`}>
          <path d={OUTLINE} className={index % 2 === 0 ? "fill-kumo-badge-green stroke-kumo-success" : "fill-kumo-success stroke-kumo-success"} strokeWidth={0.8} />
          <path d={MIDLINE} className="fill-none stroke-kumo-base opacity-50" strokeWidth={0.7} />
        </g>
      ))}
      <path
        d={`M${CENTER - width / 4} ${top} C${CENTER - 3} ${top - 10} ${CENTER - 1} ${top - 18} ${CENTER + 1} ${top - 26} C${CENTER + 2} ${top - 16} ${CENTER + 3} ${top - 8} ${CENTER + width / 4} ${top} Z`}
        className="fill-kumo-badge-teal stroke-kumo-success"
        strokeWidth={0.8}
      />
    </g>
  );
}

/** The root: the trunk flares into the ground and its roots spread over and under it. */
function RootBase({ width }: { readonly width: number }) {
  const half = width / 2;
  const ground = 58;

  return (
    <g>
      <path
        d={`M${CENTER - half} ${NODE_Y} C${CENTER - half} 44 ${CENTER - half - 6} 52 ${CENTER - half - 18} ${ground} L${CENTER + half + 18} ${ground} C${CENTER + half + 6} 52 ${CENTER + half} 44 ${CENTER + half} ${NODE_Y} Z`}
        className="fill-kumo-badge-neutral"
      />
      <path
        d={`M${CENTER - half} ${NODE_Y} C${CENTER - half} 44 ${CENTER - half - 6} 52 ${CENTER - half - 18} ${ground} L${CENTER + half + 18} ${ground} C${CENTER + half + 6} 52 ${CENTER + half} 44 ${CENTER + half} ${NODE_Y} Z`}
        className="fill-kumo-badge-orange stroke-kumo-line opacity-25"
        strokeWidth={1}
      />
      <path d={`M0 ${ground} L${WIDTH} ${ground}`} className="fill-none stroke-kumo-line" strokeWidth={1.5} />
      <path
        d={`M${CENTER - half - 12} ${ground} C30 62 18 64 4 70 M${CENTER - 5} ${ground} C${CENTER - 7} 66 ${CENTER - 11} 72 ${CENTER - 16} 79 M${CENTER + 5} ${ground} C${CENTER + 9} 66 ${CENTER + 13} 72 ${CENTER + 19} 79 M${CENTER + half + 12} ${ground} C66 62 78 64 92 70`}
        className="fill-none stroke-kumo-badge-neutral opacity-70"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </g>
  );
}

interface GraftProps {
  readonly width: number;
  /** The node's id: separate grafts lean differently, so they do not look stamped. */
  readonly node: number;
  /** How many grafts share the row: more of them hang down. */
  readonly run: number;
}

/** Where a graft's hanging lines drop from, and to: x and the heights they span. */
const HANGING = [
  [9, 8, 66],
  [16, 12, 50],
  [4, 4, 76],
] as const;

/** A graft: the outside commit comes down from above as a root and joins the trunk at the node, more lines hanging free beside it. */
function GraftJoin({ width, node, run }: GraftProps) {
  const edge = CENTER - width / 2;
  const lean = (node % 3) * 3;

  return (
    <g className="fill-none stroke-kumo-badge-neutral" strokeLinecap="round">
      <path d={`M${2 + lean} -10 C${4 + lean} 10 ${edge - 14} 14 ${edge + 1} ${NODE_Y + 3}`} strokeWidth={3.4} />
      <path d={`M${2 + lean} -10 C${4 + lean} 10 ${edge - 14} 14 ${edge + 1} ${NODE_Y + 3}`} strokeWidth={1} className="stroke-kumo-line" />
      {HANGING.slice(0, Math.max(1, Math.min(run, HANGING.length))).map(([x, from, to]) => (
        <path key={x} d={`M${x + lean} ${from} C${x + lean + 1} ${from + 18} ${x + lean - 1} ${to - 18} ${x + lean} ${to}`} strokeWidth={1.4} className="opacity-70" />
      ))}
    </g>
  );
}

interface NodeDrawingProps {
  readonly story: NodeStory;
  /** The trunk's width at the node. */
  readonly width: number;
  /** How many grafts share the row (1 for any other node). */
  readonly run: number;
}

/** Everything at one node: drawn at the top of its row, over the trunk. */
export function NodeDrawing({ story, width, run }: NodeDrawingProps) {
  return (
    <svg className="relative block h-auto w-16 overflow-visible sm:w-24" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden="true">
      {story.kind === "graft" ? <GraftJoin width={width} node={story.node} run={run} /> : null}
      {story.parent === null ? <RootBase width={width} /> : null}
      {story.head ? <HeadCrown width={width} /> : null}
      <NodeRing width={width} />
      {attemptChains(story.attempts)
        .slice(0, PLACES.length)
        .map(({ last, rebased, retried }, place) => (
          <AttemptMark key={last.attempt} outcome={last.outcome} moved={rebased + retried > 0} place={place} width={width} />
        ))}
      {deployMarks(story).map((mark) => (
        <DeployMark key={mark.place} {...mark} width={width} />
      ))}
    </svg>
  );
}
