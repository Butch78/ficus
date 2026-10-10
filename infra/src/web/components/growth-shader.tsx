"use client";

/**
 * Ficus's shaders (shaders.com, MIT, WebGPU with a WebGL fallback), coloured
 * with Kumo's tokens: a reaction-diffusion growth pattern behind a tree's or
 * an organization's heading, and flowing strands, like a ficus's aerial roots,
 * while a page loads. Telemetry to shaders.com is off; with reduced motion
 * they hold still; where the GPU cannot run them they leave the space plain.
 */
import { useState } from "react";
import { ReactionDiffusion, Shader, Strands } from "shaders/react";
import { useKumoColors, useReducedMotion } from "../lib/kumo-colors.ts";

interface Props {
  /** Where the canvas sits and how big it is. */
  readonly className: string;
}

/**
 * Shared by both: nothing until the browser has Kumo's colors, nothing again
 * if the GPU gives up, and the canvas invisible until its first frame is
 * ready, so a GPU that half works shows the plain card rather than a blank one.
 */
const useCanvas = (className: string) => {
  const colors = useKumoColors();
  const still = useReducedMotion();
  const [unavailable, setUnavailable] = useState(false);
  const [ready, setReady] = useState(false);

  return {
    colors: unavailable ? undefined : colors,
    still,
    canvas: {
      className: `${className} transition-opacity duration-700 ${ready ? "opacity-100" : "opacity-0"}`,
      disableTelemetry: true,
      onReady: () => setReady(true),
      onUnavailable: () => setUnavailable(true),
      "aria-hidden": "true",
    },
  };
};

/** A slow growth pattern in Kumo's greens, for behind a heading; decorative. */
export function GrowthBackdrop({ className }: Props) {
  const { colors, still, canvas } = useCanvas(className);

  if (colors === undefined) {
    return null;
  }

  return (
    <Shader {...canvas}>
      <ReactionDiffusion preset="coral" colorA="transparent" colorB={colors.green} colorC={colors.success} speed={still ? 0 : 2} featureSize={4} contrast={0.4} />
    </Shader>
  );
}

/** Strands drifting across, like a ficus's aerial roots in the wind, for while a page loads; decorative. */
export function RootsLoader({ className }: Props) {
  const { colors, still, canvas } = useCanvas(className);

  if (colors === undefined) {
    return null;
  }

  const stops = [
    { color: colors.green, position: 0 },
    { color: colors.teal, position: 0.5 },
    { color: colors.success, position: 1 },
  ];

  return (
    <Shader {...canvas}>
      <Strands stops={stops} speed={still ? 0 : 0.6} lineCount={14} amplitude={1.6} frequency={0.35} lineWidth={0.035} softness={0.08} spread={0.35} />
    </Shader>
  );
}
