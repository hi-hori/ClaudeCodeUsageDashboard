// Repository name shown on the dashboard, derived from a session's project_dir.
//
// Kept free of imports so scripts/backfill-repo-name.mjs can load this same
// file under plain Node (type stripping) — the backfill must name rows exactly
// as ingest does, or the renamed history and new uploads would split into two
// repositories.

/** Folder names that say which line of development a checkout is, not which
 *  repository: "D:\\Dev\\TMSR7\\trunk" and "D:\\Dev\\TMKP2\\trunk" are both
 *  "trunk" on their own. Compared case-insensitively. */
const GENERIC_DIR_NAMES = new Set([
  "trunk",
  "head",
  "tip",
  "dev",
  "develop",
  "development",
  "main",
  "master",
  "src",
  "source",
  "work",
  "current",
  "latest",
  "release",
  // A checkout of the branches / tags folder itself.
  "branches",
  "tags",
]);

/** Subversion's standard layout: the folder below these is a branch or tag
 *  name ("feature1", "v1.0"), which says nothing about the repository either,
 *  however specific it looks. Compared case-insensitively. */
const BRANCH_CONTAINER_NAMES = new Set(["branches", "tags"]);

/** Last path segment of a project directory, with its parent folders prepended
 *  while the segment does not name the repository:
 *
 *    D:\\Dev\\TMSR7\\trunk              -> TMSR7/trunk
 *    D:\\Dev\\TMSR7\\branches\\feature1  -> TMSR7/branches/feature1
 *    D:\\Dev\\TMSR7\\tags\\v1.0          -> TMSR7/tags/v1.0
 *
 *  Windows backslashes are normalized so "D:\\Work\\repo" and "/home/me/repo"
 *  both yield "repo". */
export function repoNameFromProjectDir(projectDir: string): string {
  const segs = projectDir
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && !/^[A-Za-z]:$/.test(s)); // drop empty parts and drive letters
  if (segs.length === 0) return projectDir;

  let i = segs.length - 1;
  while (i > 0) {
    // Checked first: a branch named "dev" or "main" is still a branch.
    if (BRANCH_CONTAINER_NAMES.has(segs[i - 1].toLowerCase())) i = Math.max(i - 2, 0);
    else if (GENERIC_DIR_NAMES.has(segs[i].toLowerCase())) i--;
    else break;
  }
  return segs.slice(i).join("/");
}
