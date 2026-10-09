#!/usr/bin/env node
// issuechan for Claude Code: the MCP channel server that ~/.claude.json runs.
import { runIssuechan } from '../../core/issuechan.mjs'
import adapter from './adapter.mjs'

await runIssuechan(adapter)
