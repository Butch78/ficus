/**
 * "What happened": an operation's Cloudflare trace, as steps a person reads.
 *
 * Every Worker here has traces on, and same-account service bindings share
 * one trace, so an init is one trace from the UI through the Api, the tree
 * Worker and its Durable Object, down to each Artifacts and D1 call. This
 * module turns that trace's spans (Workers Observability events) into
 * labelled, nested steps. Pure, so it tests without the API.
 */
import * as Schema from "effect/Schema";

/** The span attributes the UI sets on its own operations (lib/trace.ts). */
export const OPERATION_ATTRIBUTE = "ficus.operation";

export const ORG_ATTRIBUTE = "ficus.org";

/** Absent or null: the API attempts fields out, or sends them empty. */
const maybe = <S extends Schema.Constraint>(schema: S) => Schema.optional(Schema.NullOr(schema));

const Metadata = Schema.Struct({
  traceId: Schema.String,
  spanId: maybe(Schema.String),
  parentSpanId: maybe(Schema.String),
  type: maybe(Schema.String),
  service: maybe(Schema.String),
  spanName: maybe(Schema.String),
  transactionName: maybe(Schema.String),
  startTime: maybe(Schema.Number),
  endTime: maybe(Schema.Number),
  error: maybe(Schema.String),
});

/** One Workers Observability event, the fields a step needs. */
export const TraceEvent = Schema.Struct({ $metadata: Metadata });

export type TraceEvent = typeof TraceEvent.Type;

/** The UI's own operation spans are named `ficus.<operation>` (lib/trace.ts). */
const isOperation = (name: string) => name.startsWith("ficus.");

export interface Step {
  readonly id: string;
  /** How many steps up the operation it sits, for indenting. */
  readonly depth: number;
  readonly where: string;
  readonly label: string;
  /** Milliseconds from the operation's start. */
  readonly offset: number;
  /** Total time of the step, summed over its repeats. */
  readonly duration: number;
  /** Identical steps in a row (nine session lookups) show as one, counted. */
  readonly count: number;
  readonly failed: boolean;
}

/** Which part of Ficus a Worker script is, by the stack's naming. */
export const where = (service: string) => {
  if (service.startsWith("ficus-web-")) {
    return "UI";
  }

  if (service.startsWith("ficus-api-")) {
    return "Api";
  }

  if (service.startsWith("ficus-sandbox-")) {
    return "Sandbox";
  }

  return "Tree";
};

/** Platform span names, said the way the reader thinks of them. */
export const label = (service: string, name: string) => {
  const rpc = /^RPC call: (.+)$/.exec(name);

  // The tree Worker's only RPC binding is Artifacts.
  if (rpc?.[1] !== undefined && where(service) === "Tree") {
    return `Artifacts: ${rpc[1]}`;
  }

  const d1 = /^d1 (\w+)/.exec(name);

  if (d1?.[1] !== undefined) {
    return name.includes("ficus_tree") ? "D1: record the tree in the directory" : "D1: session and membership lookup";
  }

  if (name.startsWith("durable_object_storage_")) {
    return `Durable Object storage: ${name.slice("durable_object_storage_".length)}`;
  }

  if (name === "durable_object_subrequest") {
    return "Hand to the tree's Durable Object";
  }

  if (isOperation(name)) {
    return `Your ${name.slice("ficus.".length)}`;
  }

  return name;
};

/** Spans that only frame others (an RPC session around its calls). */
const isFrame = (name: string) => name === "RPC session";

/** A single binding call: it never opens spans of its own, so it adopts none. */
const isCall = (name: string) =>
  name.startsWith("RPC call: ") || name.startsWith("durable_object_storage_") || name.startsWith("d1 ");

interface Span {
  readonly id: string;
  readonly parent: string | undefined;
  readonly service: string;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly failed: boolean;
}

const spansOf = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<Span> =>
  events.flatMap(({ $metadata: span }) =>
    span.type === "span" && span.spanId !== undefined && span.spanId !== null && span.startTime !== undefined && span.startTime !== null
      ? [
          {
            id: span.spanId,
            parent: span.parentSpanId ?? undefined,
            service: span.service ?? "",
            name: span.transactionName ?? span.spanName ?? "span",
            start: span.startTime,
            end: Math.max(span.startTime, span.endTime ?? span.startTime),
            failed: span.error !== undefined && span.error !== null,
          },
        ]
      : [],
  );

/**
 * Each span's parent within the trace. A Durable Object's spans can arrive
 * without the span that opened them; such a span is put under the innermost
 * span that encloses it in time, preferring its own Worker's.
 */
const parentsOf = (spans: ReadonlyArray<Span>) => {
  const ids = new Set(spans.map((span) => span.id));
  const recorded = new Map(spans.map((span) => [span.id, span.parent]));

  // A span's own descendants can share its extent (an RPC session and its
  // one call); adopting one of them would make a cycle.
  const descendsFrom = (span: Span, ancestor: string) => {
    let current = span.parent;

    for (let hops = 0; current !== undefined && hops <= spans.length; hops += 1) {
      if (current === ancestor) {
        return true;
      }

      current = recorded.get(current);
    }

    return false;
  };

  const encloser = (orphan: Span) =>
    spans
      .filter(
        (span) =>
          span.id !== orphan.id &&
          span.start <= orphan.start &&
          span.end >= orphan.end &&
          !isCall(span.name) &&
          !descendsFrom(span, orphan.id),
      )
      .toSorted((a, b) => Number(b.service === orphan.service) - Number(a.service === orphan.service) || b.start - a.start || a.end - b.end)[0]?.id;

  return new Map(
    spans.map((span) => [span.id, span.parent !== undefined && ids.has(span.parent) ? span.parent : encloser(span)]),
  );
};

/**
 * The trace as steps: the UI's operation span and everything under it, in
 * start order, frames dropped, and identical neighbours folded together.
 * Without an operation span, the whole trace.
 */
export const steps = (events: ReadonlyArray<TraceEvent>): ReadonlyArray<Step> => {
  const spans = spansOf(events);
  const parents = parentsOf(spans);
  const root = spans.find((span) => isOperation(span.name));

  // Steps from the span up to the operation (or to the top, without one);
  // -1 for a span outside the operation. Bounded, in case enclosing spans
  // of equal extent adopt each other.
  // Frames are not shown, so they do not indent.
  const frames = new Set(spans.filter((span) => isFrame(span.name)).map((span) => span.id));

  const depthOf = (span: Span) => {
    let depth = 0;
    let hops = 0;
    let current: string | undefined = span.id;

    while (current !== undefined && current !== root?.id && hops <= spans.length) {
      current = parents.get(current);
      hops += 1;
      depth += current !== undefined && frames.has(current) ? 0 : 1;
    }

    return root === undefined ? depth - 1 : current === root.id ? depth : -1;
  };

  const shown = spans
    .map((span) => ({ span, depth: depthOf(span) }))
    .filter(({ span, depth }) => depth >= 0 && !isFrame(span.name))
    .toSorted((a, b) => a.span.start - b.span.start || a.depth - b.depth);

  const origin = root?.start ?? Math.min(...spans.map((span) => span.start));

  const folded: Array<Step> = [];

  for (const { span, depth } of shown) {
    const step: Step = {
      id: span.id,
      depth,
      where: where(span.service),
      label: label(span.service, span.name),
      offset: span.start - origin,
      duration: span.end - span.start,
      count: 1,
      failed: span.failed,
    };

    const previous = folded.at(-1);

    if (previous !== undefined && previous.label === step.label && previous.depth === step.depth && previous.where === step.where) {
      folded[folded.length - 1] = {
        ...previous,
        duration: previous.duration + step.duration,
        count: previous.count + 1,
        failed: previous.failed || step.failed,
      };
    } else {
      folded.push(step);
    }
  }

  return folded;
};

/** A step said as a sentence, for the expanded summary. */
export interface Sentence {
  readonly text: string;
  readonly offset: number;
  /** From the first of its steps starting to the last one ending. */
  readonly duration: number;
  readonly failed: boolean;
}

/**
 * What a step means to the person who asked for it; undefined for the
 * plumbing between (requests passing through, framework rendering), which
 * stays in the raw spans.
 */
export const sentence = (label: string) => {
  switch (label) {
    case "Api.membership":
      return "Checked you belong to the organization";
    case "Hand to the tree's Durable Object":
      return "Handed the request to the tree's Durable Object";
    case "Artifacts: create":
      return "Created an empty root repository in Artifacts";
    case "Artifacts: import":
      return "Imported the repository into Artifacts";
    case "Artifacts: fork":
      return "Forked a repository for the attempt";
    case "Artifacts: createToken":
      return "Minted a token for the repository";
    case "Artifacts: get":
    case "Artifacts: log":
      return "Read the repository's head commit";
    case "Artifacts: listTokens":
    case "Artifacts: revokeToken":
      return "Locked the root: revoked its write tokens";
    case "Durable Object storage: put":
      return "Saved the tree";
    case "Directory.record":
    case "D1: record the tree in the directory":
      return "Listed the tree in your organization";
    default:
      return undefined;
  }
};

/** The steps a person cares about, in order, neighbours saying the same thing merged. */
export const narrate = (all: ReadonlyArray<Step>): ReadonlyArray<Sentence> => {
  const told: Array<Sentence> = [];

  for (const step of all) {
    const text = sentence(step.label);

    if (text === undefined) {
      continue;
    }

    const previous = told.at(-1);

    if (previous?.text === text) {
      const end = Math.max(previous.offset + previous.duration, step.offset + step.duration);

      told[told.length - 1] = { ...previous, duration: end - previous.offset, failed: previous.failed || step.failed };
    } else {
      told.push({ text, offset: step.offset, duration: step.duration, failed: step.failed });
    }
  }

  return told;
};
