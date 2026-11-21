/**
 * Essay filenames are case-sensitive: a capital "E", then anything, then ".txt".
 * `E01-short-title.txt` matches. `e01-short-title.txt` and `E01-short-title.TXT` do not.
 *
 * The Vite build glob `../../essays/E*.txt` and the dev-server `/api/essays`
 * filter both use this test, so a file is either in both or in neither.
 * (`import.meta.glob` needs a static pattern, so the glob stays a literal
 * and this function is the shared rule applied to every candidate.)
 */
export const ESSAY_FILE = /^E.*\.txt$/

export function isEssayFile(name) {
  const file = String(name).split(/[/\\]/).pop() ?? ''
  return ESSAY_FILE.test(file)
}
