#!/usr/bin/env node
// issuechan for Codex: the MCP server that the Codex app-server runs (one process per thread).
import { runIssuechan } from '../../core/issuechan.mjs'
import adapter from './adapter.mjs'

await runIssuechan(adapter)
