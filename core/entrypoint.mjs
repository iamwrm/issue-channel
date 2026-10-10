// File URLs escape spaces, # and non-ASCII characters; CLI paths do not.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMain(url, argv = process.argv) {
  if (!argv[1]) return false
  try { return fs.realpathSync(fileURLToPath(url)) === fs.realpathSync(argv[1]) }
  catch { return false }
}
