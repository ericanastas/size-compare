import { getActiveUnit } from "./units";

export function convertDisplayUnits(meters: number): string {
  return getActiveUnit().displayValue(meters);
}
