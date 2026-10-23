export interface IssueDelivery { content: string; meta: Record<string, string>; }
export interface IssueSubscriptionStatus { repo: string; issue: number; mode: 'bot' | 'updates'; connected: boolean; cursor?: number; openRequests?: (string | number)[]; }
export interface IssueStatus { session: string; subscriptions: IssueSubscriptionStatus[]; error?: string; }
export interface ReplyFooter { model?: string; thinking?: string; used?: number; window?: number; }
export interface IssueTool { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface IssueToolResult { content: { type: 'text'; text: string }[]; isError?: boolean; }
export interface IssueEngine { start(): Promise<void>; stop(): Promise<void>; callTool(name: string, args?: Record<string, unknown>): Promise<IssueToolResult>; getStatus(): IssueStatus; }
export const ISSUE_TOOLS: IssueTool[];
export function createIssueEngine(options: {
  agent: { agent: string; id: string };
  session?: string;
  stateDir?: string;
  env?: Record<string, string | undefined>;
  deliver: (delivery: IssueDelivery) => Promise<void>;
  onStatus?: (status: IssueStatus) => void;
  replyFooter?: () => ReplyFooter | Promise<ReplyFooter>;
  log?: (...args: unknown[]) => void;
}): IssueEngine;
