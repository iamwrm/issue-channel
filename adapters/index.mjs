// Every harness adapter, for tools that must recognize any of them (e.g. core/reply-format.mjs).
import claudeCode from './claude-code/adapter.mjs'

export const ADAPTERS = [claudeCode]
export const AGENT_ENV = ADAPTERS.flatMap(a => a.agentEnv)
