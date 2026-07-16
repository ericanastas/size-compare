import type { SizeObject } from "./types";
import { colorForIndex } from "./state";
import { getActiveUnit } from "./units";

const PARAM = "state";
const UNIT_PARAM = "unit";

type EncodedObject = [name: string, width: number, height: number, depth: number, x: number, y: number, z: number];

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (padded.length % 4)) % 4;
  const binary = atob(padded + "=".repeat(padding));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function buildShareUrl(objects: readonly SizeObject[]): string {
  const payload: EncodedObject[] = objects.map((o) => [
    o.name,
    o.width,
    o.height,
    o.depth,
    round(o.position.x),
    round(o.position.y),
    round(o.position.z),
  ]);

  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set(PARAM, base64UrlEncode(JSON.stringify(payload)));
  // Encode the active display unit so a shared link opens in the sender's
  // unit. Geometry above is always meters and unaffected by this.
  url.searchParams.set(UNIT_PARAM, getActiveUnit().abbreviation);
  return url.toString();
}

export function decodeUnitFromLocation(): string | null {
  return new URLSearchParams(window.location.search).get(UNIT_PARAM);
}

export function decodeStateFromLocation(): SizeObject[] | null {
  const raw = new URLSearchParams(window.location.search).get(PARAM);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const objects: SizeObject[] = [];
  let nextId = 1;
  for (const item of parsed as unknown[]) {
    if (!Array.isArray(item) || item.length !== 7) continue;
    const [name, width, height, depth, x, y, z] = item as unknown[];
    if (typeof name !== "string" || !name) continue;
    if (!isFiniteNumber(width) || width <= 0) continue;
    if (!isFiniteNumber(height) || height <= 0) continue;
    if (!isFiniteNumber(depth) || depth <= 0) continue;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) continue;

    const index = objects.length;
    objects.push({
      id: String(nextId++),
      name,
      width,
      height,
      depth,
      color: colorForIndex(index),
      position: { x, y, z },
    });
  }

  return objects.length > 0 ? objects : null;
}
