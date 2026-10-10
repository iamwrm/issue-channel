import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { isMain } from './entrypoint.mjs'

test('entrypoint detection decodes file URLs, resolves symlinks, and tolerates imports without argv[1]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue channel # ü '))
  const file = path.join(dir, 'entry # ü.mjs'), link = path.join(dir, 'alias.mjs')
  try {
    fs.writeFileSync(file, '')
    fs.symlinkSync(file, link)
    assert.equal(isMain(pathToFileURL(file).href, ['node', file]), true)
    assert.equal(isMain(pathToFileURL(file).href, ['node', link]), true)
    assert.equal(isMain(pathToFileURL(file).href, ['node']), false)
    assert.equal(isMain(pathToFileURL(file).href, ['node', path.join(dir, 'missing')]), false)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Linear and session-fork CLI entrypoints execute from a checkout containing spaces and #', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue channel # '))
  try {
    for (const name of ['core/entrypoint.mjs', 'core/linear.mjs', 'core/lib.mjs', 'session-fork/session-fork.mjs', 'skills/issue-channel/scripts/linear.mjs']) {
      const out = path.join(dir, name)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.copyFileSync(fileURLToPath(new URL('../' + name, import.meta.url)), out)
    }
    for (const [name, message] of [['skills/issue-channel/scripts/linear.mjs', /unknown command/], ['session-fork/session-fork.mjs', /usage: session-fork/]]) {
      assert.throws(() => execFileSync(process.execPath, [path.join(dir, name)], { stdio: 'pipe' }), error => {
        assert.match(error.stderr.toString(), message)
        assert.notEqual(error.status, 0)
        return true
      })
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('server CLI still starts as the standalone file copied by Docker, including escaped paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue server # ü '))
  try {
    const entry = path.join(dir, 'server.mjs')
    fs.copyFileSync(fileURLToPath(new URL('../server/server.mjs', import.meta.url)), entry)
    assert.throws(() => execFileSync(process.execPath, [entry], {
      env: { ...process.env, DB_PATH: ':memory:', WEBHOOK_SECRET: '' }, stdio: 'pipe',
    }), error => {
      assert.equal(error.status, 2)
      assert.match(error.stderr.toString(), /WEBHOOK_SECRET must be set/)
      assert.doesNotMatch(error.stderr.toString(), /ERR_MODULE_NOT_FOUND/)
      return true
    })
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
