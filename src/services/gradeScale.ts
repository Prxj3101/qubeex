export type GradeScaleEntry = { grade: string; minPct: number };

export function resolveGrade(pct: number, scale: GradeScaleEntry[]): string {
  if (scale.length === 0) {
    // Fallback to built-in scale when the class teacher hasn't configured one.
    if (pct >= 75) return "A";
    if (pct >= 60) return "B";
    if (pct >= 45) return "C";
    if (pct >= 35) return "D";
    return "F";
  }
  const sorted = [...scale].sort((a, b) => b.minPct - a.minPct);
  for (const entry of sorted) {
    if (pct >= entry.minPct) return entry.grade;
  }
  return sorted[sorted.length - 1]?.grade ?? "F";
}
