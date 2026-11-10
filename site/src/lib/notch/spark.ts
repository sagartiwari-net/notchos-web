/**
 * Sparkline geometry for the System face, the same construction as VitalSparkline in
 * Lumen/Sources/VitalChrome.swift: samples 0..1, inset inside the well, smoothed with
 * Catmull-Rom style control points ((p2 - p0) / 6).
 */

export interface Spark {
  /** SVG path of the line. */
  line: string;
  /** SVG path of the filled area under the line. */
  fill: string;
}

const round = (v: number) => Math.round(v * 100) / 100;

export function sparkPath(values: number[], width = 100, height = 34): Spark {
  const n = values.length;
  const point = (i: number): [number, number] => {
    const v = Math.min(1, Math.max(0, values[i]));
    const x = (i / Math.max(n - 1, 1)) * width;
    const y = height - v * (height * 0.78) - height * 0.12;
    return [x, y];
  };
  let line = `M${round(point(0)[0])} ${round(point(0)[1])}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = point(Math.max(i - 1, 0));
    const p1 = point(i);
    const p2 = point(i + 1);
    const p3 = point(Math.min(i + 2, n - 1));
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    line += ` C${round(c1[0])} ${round(c1[1])} ${round(c2[0])} ${round(c2[1])} ${round(p2[0])} ${round(p2[1])}`;
  }
  const fill = `${line} L${width} ${height} L0 ${height} Z`;
  return { line, fill };
}
