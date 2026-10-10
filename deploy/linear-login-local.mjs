#!/usr/bin/env node
// Run PKCE login on this computer without Docker or a public tunnel.
import crypto from 'node:crypto'

const port = Number(process.env.PORT ?? 8795)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer between 1 and 65535')
  process.exit(2)
}
const secret = crypto.randomBytes(24).toString('hex')
Object.assign(process.env, {
  PORT: String(port), LOGIN_SECRET: secret, PUBLIC_URL: `http://127.0.0.1:${port}`,
})
console.error(`Login page: ${process.env.PUBLIC_URL}/${secret}/`)
console.error(`Callback URL: ${process.env.PUBLIC_URL}/${secret}/callback`)
console.error('Add the callback URL to your Linear OAuth app, then open the login page on this computer.')
process.env.ISSUECHAN_LOGIN_EXIT_ON_DONE = '1'
setTimeout(() => {
  console.error('Local login expired; run linear-login-local.mjs again to start over.')
  process.exit(1)
}, 30 * 60 * 1000).unref()
await import('./linear-login.mjs')
