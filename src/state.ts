import type { SizeObject } from "./types";

const GAP = 2;
const PALETTE_SATURATION = 0.65;
const PALETTE_LIGHTNESS = 0.55;

export function colorForIndex(index: number): number {
  const hue = (index * 0.137) % 1;
  const color = { r: 0, g: 0, b: 0 };
  hslToRgb(hue, PALETTE_SATURATION, PALETTE_LIGHTNESS, color);
  return (color.r << 16) | (color.g << 8) | color.b;
}

function hslToRgb(h: number, s: number, l: number, out: { r: number; g: number; b: number }) {
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out.r = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
  out.g = Math.round(hue2rgb(p, q, h) * 255);
  out.b = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);
}

export class ObjectStore {
  private _objects: SizeObject[] = [];
  private listeners: Array<(objects: SizeObject[]) => void> = [];
  private nextX = 0;
  private nextId = 1;

  get objects(): readonly SizeObject[] {
    return this._objects;
  }

  add(name: string, width: number, height: number, depth: number): SizeObject {
    const object = this.buildObject(name, width, height, depth, this._objects.length);
    this._objects = [...this._objects, object];
    this.notify();
    return object;
  }

  remove(id: string): void {
    this._objects = this._objects.filter((o) => o.id !== id);
    this.notify();
  }

  update(id: string, name: string, width: number, height: number, depth: number): void {
    this._objects = this._objects.map((o) =>
      o.id === id
        ? { ...o, name, width, height, depth, position: { ...o.position, y: height / 2 } }
        : o,
    );
    this.notify();
  }

  load(rows: ReadonlyArray<{ name: string; width: number; height: number; depth: number }>): void {
    this.nextX = 0;
    this.nextId = 1;
    this._objects = rows.map((row, index) =>
      this.buildObject(row.name, row.width, row.height, row.depth, index),
    );
    this.notify();
  }

  loadFull(objects: readonly SizeObject[]): void {
    this._objects = [...objects];
    this.nextId = objects.reduce((max, o) => Math.max(max, Number(o.id) || 0), 0) + 1;
    this.nextX = objects.reduce((max, o) => Math.max(max, o.position.x + o.width / 2 + GAP), 0);
    this.notify();
  }

  private buildObject(
    name: string,
    width: number,
    height: number,
    depth: number,
    colorIndex: number,
  ): SizeObject {
    const id = String(this.nextId++);
    const x = this.nextX + width / 2;
    this.nextX += width + GAP;

    return {
      id,
      name,
      width,
      height,
      depth,
      color: colorForIndex(colorIndex),
      position: { x, y: height / 2, z: 0 },
    };
  }

  subscribe(fn: (objects: SizeObject[]) => void): () => void {
    this.listeners.push(fn);
    fn(this._objects);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) fn(this._objects);
  }
}
