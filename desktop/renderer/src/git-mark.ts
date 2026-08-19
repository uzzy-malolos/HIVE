export function markCodeForGitXy(xy: string): "U" | "M" | "A" | "." {
  const code = xy.replaceAll(" ", "");
  if (xy.includes("?")) return "U";
  if (code.includes("A")) return "A";
  if (code.includes("M") || code.includes("D") || code.includes("R")) return "M";
  return ".";
}
