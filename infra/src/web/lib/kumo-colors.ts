/**
 * Kumo's semantic colors as values a canvas can use: shaders take colors as
 * strings, and Kumo's tokens are CSS (light-dark(), switched by the page's
 * mode), so each is read off an element wearing its class once the page is
 * in the browser, and again when the mode changes. The classes are written
 * out whole so Tailwind generates them.
 */
import { useEffect, useState } from "react";

const CLASSES = {
  brand: "text-kumo-brand",
  success: "text-kumo-success",
  green: "text-kumo-badge-green",
  teal: "text-kumo-badge-teal",
  canvas: "text-kumo-canvas",
} as const;

export type KumoColor = keyof typeof CLASSES;

export type KumoColors = Readonly<Record<KumoColor, string>>;

/** Each color as the browser resolves it now: a CSS color string a shader can parse. */
const resolve = (): KumoColors => {
  const probe = document.createElement("span");

  probe.style.display = "none";
  document.body.appendChild(probe);

  const read = (color: KumoColor) => {
    probe.className = CLASSES[color];

    return getComputedStyle(probe).color;
  };

  const colors: KumoColors = {
    brand: read("brand"),
    success: read("success"),
    green: read("green"),
    teal: read("teal"),
    canvas: read("canvas"),
  };

  probe.remove();

  return colors;
};

/** Kumo's colors once in the browser (undefined while server-rendering), kept in step with light and dark. */
export const useKumoColors = () => {
  const [colors, setColors] = useState<KumoColors | undefined>(undefined);

  useEffect(() => {
    const update = () => setColors(resolve());
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const mode = new MutationObserver(update);

    update();
    scheme.addEventListener("change", update);
    mode.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode", "class"] });

    return () => {
      scheme.removeEventListener("change", update);
      mode.disconnect();
    };
  }, []);

  return colors;
};

/** Whether the person asked for less motion: shaders then hold still. */
export const useReducedMotion = () => {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);

    update();
    query.addEventListener("change", update);

    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
};
