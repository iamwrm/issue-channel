#!/usr/bin/env node
// A deliberately tiny, offline gh executable for native issue_reply coverage.
import fs from 'node:fs'
const args = process.argv.slice(2)
if (args.length === 0 && !process.env.ISSUECHAN_TEST_GH_LOG) {
  // Safe to import as a fixture: no execution without a test invocation.
} else if (JSON.stringify(args) === JSON.stringify(['api', 'user'])) {
  console.log(JSON.stringify({ login: 'test-agent' }))
} else if (args[0] === 'issue' && args[1] === 'comment' && args.includes('--body-file')) {
  let body = ''
  for await (const chunk of process.stdin) body += chunk
  fs.appendFileSync(process.env.ISSUECHAN_TEST_GH_LOG, JSON.stringify({ args, body }) + '\n')
  console.log('https://github.com/o/r/issues/1#issuecomment-9000')
} else {
  console.error(`Unexpected gh invocation: ${JSON.stringify(args)}`)
  process.exitCode = 97
}
