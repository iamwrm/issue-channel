// Every harness adapter, for tools that must recognize any of them (e.g. core/reply-format.mjs).
import claudeCode from './claude-code/adapter.mjs'
import codex from './codex/adapter.mjs'

export const ADAPTERS = [claudeCode, codex]
export const AGENT_ENV = ADAPTERS.flatMap(a => a.agentEnv)
