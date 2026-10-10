"use client";

/**
 * Ficus's shaders (shaders.com, MIT, WebGPU), coloured with Kumo's tokens: a
 * slow mesh gradient behind the sign-in card, and flowing strands, like a
 * ficus's aerial roots, while a page loads. Telemetry to shaders.com is off; with reduced motion
 * they hold still; where the GPU cannot run them they leave the space plain.
 */
import { useState } from "react";
import { MeshGradient, Shader, Strands } from "shaders/react";
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

/** Soft fields of Kumo's greens drifting slowly, for behind the sign-in card; calm enough to sit under a form. Decorative. */
export function SignInBackdrop({ className }: Props) {
  const { colors, still, canvas } = useCanvas(className);

  if (colors === undefined) {
    return null;
  }

  const stops = [
    { color: colors.canvas, position: 0 },
    { color: colors.green, position: 0.45 },
    { color: colors.teal, position: 0.75 },
    { color: colors.canvas, position: 1 },
  ];

  return (
    <Shader {...canvas}>
      <MeshGradient stops={stops} count={4} smoothness={3} variation={0.25} swirl={0.2} drift={0.3} speed={still ? 0 : 0.25} />
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
