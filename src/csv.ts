import type { SizeObject } from "./types";

const HEADER = ["name", "width", "depth", "height", "x", "y", "z"];

export interface ShapeRow {
  name: string;
  width: number;
  height: number;
  depth: number;
  position?: { x: number; y: number; z: number };
}

export interface ParseCsvResult {
  rows: ShapeRow[];
  skipped: number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function objectsToCsv(objects: readonly SizeObject[]): string {
  const lines = [HEADER.join(",")];
  for (const object of objects) {
    lines.push(
      [
        object.name,
        object.width,
        object.depth,
        object.height,
        round(object.position.x),
        round(object.position.y),
        round(object.position.z),
      ]
        .map((value) => escapeCsvField(String(value)))
        .join(","),
    );
  }
  return lines.join("\r\n");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseShapesCsv(text: string): ParseCsvResult {
  const lines = text.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { rows: [], skipped: 0 };

  const firstFields = parseCsvLine(lines[0]).map((field) => field.trim().toLowerCase());
  const dataLines = firstFields.join(",") === HEADER.join(",") ? lines.slice(1) : lines;

  const rows: ShapeRow[] = [];
  let skipped = 0;
  for (const line of dataLines) {
    const fields = parseCsvLine(line);
    const name = (fields[0] ?? "").trim();
    const width = Number(fields[1]);
    const depth = Number(fields[2]);
    const height = Number(fields[3]);
    if (!name || ![width, height, depth].every((n) => Number.isFinite(n) && n > 0)) {
      skipped++;
      continue;
    }

    // Position columns are optional — older exports (or hand-edited files)
    // may omit them, in which case the object falls back to the origin.
    const x = Number(fields[4]);
    const y = Number(fields[5]);
    const z = Number(fields[6]);
    const position = [x, y, z].every((n) => Number.isFinite(n)) ? { x, y, z } : undefined;

    rows.push({ name, width, height, depth, position });
  }
  return { rows, skipped };
}
