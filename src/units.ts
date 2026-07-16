// Units are a display/input concern only — internally every dimension is
// stored in meters (see SizeObject). A UnitSystem knows how to render meters
// for the user and how to interpret what the user types back.
export interface UnitSystem {
  name: string; // "Inches" — shown in the dropdown
  abbreviation: string; // "in" — used in field labels and the share URL
  displayValue(meters: number): string; // meters -> display string ("12.00 in")
  parseInput(input: string): number | null; // suffixed string -> meters, else null
  convertInput(value: number): number; // a pure number in this unit -> meters
}

// Every length unit is just a constant meters-per-unit factor, so the whole
// UnitSystem is derivable from that factor plus the suffix tokens the parser
// should recognize.
function lengthUnit(
  name: string,
  abbreviation: string,
  metersPerUnit: number,
  suffixes: string[],
): UnitSystem {
  // Anchored full-match: a number, optional whitespace, then exactly one of
  // this unit's suffixes and nothing else. Anchoring is what keeps "5 mm" from
  // also matching the "m" unit — the trailing "m" would leave "m" unmatched.
  const pattern = new RegExp(
    `^\\s*(-?\\d*\\.?\\d+)\\s*(?:${suffixes.map(escapeRegExp).join("|")})\\s*$`,
    "i",
  );

  return {
    name,
    abbreviation,
    displayValue(meters) {
      return `${(meters / metersPerUnit).toFixed(2)} ${abbreviation}`;
    },
    parseInput(input) {
      const match = pattern.exec(input);
      if (!match) return null;
      return Number(match[1]) * metersPerUnit;
    },
    convertInput(value) {
      return value * metersPerUnit;
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Meters first — it's the default (and the internal unit).
export const UNIT_SYSTEMS: readonly UnitSystem[] = [
  lengthUnit("Meters", "m", 1, ["m"]),
  lengthUnit("Centimeters", "cm", 0.01, ["cm"]),
  lengthUnit("Millimeters", "mm", 0.001, ["mm"]),
  lengthUnit("Feet", "ft", 0.3048, ["ft", "feet", "foot", "'"]),
  lengthUnit("Inches", "in", 0.0254, ["in", "inch", "inches", '"']),
];

const STORAGE_KEY = "size-compare:unit";
const PURE_NUMBER = /^\s*-?\d*\.?\d+\s*$/;

function findUnit(abbreviation: string | null): UnitSystem | undefined {
  if (!abbreviation) return undefined;
  return UNIT_SYSTEMS.find((u) => u.abbreviation === abbreviation);
}

function loadStoredUnit(): UnitSystem {
  try {
    return findUnit(localStorage.getItem(STORAGE_KEY)) ?? UNIT_SYSTEMS[0];
  } catch {
    return UNIT_SYSTEMS[0];
  }
}

let activeUnit: UnitSystem = loadStoredUnit();
const listeners: Array<(unit: UnitSystem) => void> = [];

export function getActiveUnit(): UnitSystem {
  return activeUnit;
}

// Switch the active unit by abbreviation, persist it, and notify subscribers.
// Unknown abbreviations are ignored so a stale localStorage/URL value can't
// wedge the app.
export function setActiveUnit(abbreviation: string): void {
  const unit = findUnit(abbreviation);
  if (!unit || unit === activeUnit) return;
  activeUnit = unit;
  try {
    localStorage.setItem(STORAGE_KEY, unit.abbreviation);
  } catch {
    // Ignore storage failures (private mode, quota) — selection still applies
    // for this session.
  }
  for (const fn of listeners) fn(activeUnit);
}

// Mirrors ObjectStore.subscribe: fires immediately with the current unit.
export function subscribeUnit(fn: (unit: UnitSystem) => void): () => void {
  listeners.push(fn);
  fn(activeUnit);
  return () => {
    const index = listeners.indexOf(fn);
    if (index >= 0) listeners.splice(index, 1);
  };
}

// The form's entry parser. A bare number is interpreted in the active unit;
// anything else must carry a recognizable suffix — the active unit is tried
// first, then the rest, so the user can enter e.g. `5 mm` while viewing inches.
export function parseToMeters(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  if (PURE_NUMBER.test(trimmed)) return activeUnit.convertInput(Number(trimmed));

  const ordered = [activeUnit, ...UNIT_SYSTEMS.filter((u) => u !== activeUnit)];
  for (const unit of ordered) {
    const meters = unit.parseInput(trimmed);
    if (meters !== null) return meters;
  }
  return null;
}

// Full-precision meters -> active-unit number, for pre-filling edit fields
// (no suffix, no rounding — so editing never truncates via displayValue's 2
// decimals). Derives the factor from convertInput to avoid a second source of
// truth.
export function metersToActiveUnitNumber(meters: number): number {
  return meters / activeUnit.convertInput(1);
}
