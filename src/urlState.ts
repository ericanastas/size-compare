import type { SizeObject } from "./types";

const PARAM = "state";

interface EncodedObject {
  n: string;
  w: number;
  h: number;
  d: number;
  c: number;
  x: number;
  y: number;
  z: number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function buildShareUrl(objects: readonly SizeObject[]): string {
  const payload: EncodedObject[] = objects.map((o) => ({
    n: o.name,
    w: o.width,
    h: o.height,
    d: o.depth,
    c: o.color,
    x: round(o.position.x),
    y: round(o.position.y),
    z: round(o.position.z),
  }));

  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set(PARAM, JSON.stringify(payload));
  return url.toString();
}

export function decodeStateFromLocation(): SizeObject[] | null {
  const raw = new URLSearchParams(window.location.search).get(PARAM);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const objects: SizeObject[] = [];
  let nextId = 1;
  for (const item of parsed as EncodedObject[]) {
    if (
      !item ||
      typeof item.n !== "string" ||
      !item.n ||
      ![item.w, item.h, item.d].every((n) => isFiniteNumber(n) && n > 0) ||
      !isFiniteNumber(item.c) ||
      ![item.x, item.y, item.z].every(isFiniteNumber)
    ) {
      continue;
    }
    objects.push({
      id: String(nextId++),
      name: item.n,
      width: item.w,
      height: item.h,
      depth: item.d,
      color: item.c,
      position: { x: item.x, y: item.y, z: item.z },
    });
  }

  return objects.length > 0 ? objects : null;
}
