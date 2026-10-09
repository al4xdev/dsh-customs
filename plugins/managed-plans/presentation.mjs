// UI-only, replay-safe views. Keep output.render on stringOutput: its JSON text
// is the model contract, not a display format. Native generic cards accept text
// ContentBlocks (Markdown source), not a separate "markdown" block/card type.
const categories = { tasks: 'Tasks', backlog: 'Backlog', 'para-o-dono': 'Owner decisions' };
const statuses = { staged: 'Staged', rejected: 'Rejected', approved: 'Approved', closed: 'Closed' };
const approval = { staged: 'Awaiting owner review', rejected: 'Rejected by owner', approved: 'Approved by owner', closed: 'Closed; no execution authorization' };
const actions = { plan_stage: 'Stage plan for owner review', plan_reopen: 'Propose reopening for owner review', exit_plan_mode: 'Submit plan for owner review (compatibility)', plan_read: 'Read plan', plan_close: 'Close plan', plan_list: 'List managed plans' };
const block = text => ({ type: 'text', text });
const integer = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Titles/paths/identifiers are data, not Markdown instructions. Source and review
// prose below deliberately keep their original Markdown instead of escaping it.
const escape = value => String(value).replace(/[\\`*_{}\[\]<>#|!]/g, '\\$&').replace(/\r?\n/g, ' ');
function literal(value) {
  const text = String(value);
  const fence = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence} ${text} ${fence}`;
}
function quotedSource(text) {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
function isSummary(value) {
  return record(value) && integer(value.plan_id) && integer(value.revision)
    && typeof value.hash === 'string' && typeof value.title === 'string' && typeof value.path === 'string'
    && Object.hasOwn(categories, value.category) && Object.hasOwn(statuses, value.status)
    && typeof value.pending_review === 'boolean' && typeof value.execution_authorized === 'boolean';
}
function parseResult(result) {
  if (result?.isError || !Array.isArray(result?.content) || !result.content.length
    || result.content.some(part => part?.type !== 'text' || typeof part.text !== 'string')) return undefined;
  try { return JSON.parse(result.content.map(part => part.text).join('')); } catch { return undefined; }
}
function identity(plan) { return `Plan ${plan.plan_id} · revision ${plan.revision}`; }
function header(plan) {
  // Native chat previews retain three physical lines. Put the lifecycle facts
  // there; full technical identity stays available in the expanded presentation.
  const lines = [
    `**${identity(plan)} — ${escape(plan.title)}**\nStatus: ${statuses[plan.status]} · Category: ${categories[plan.category]} · Approval: ${approval[plan.status]}\n**Execution authorized: ${plan.execution_authorized ? 'Yes' : 'No'}** · Owner review pending: ${plan.pending_review ? 'Yes' : 'No'}`,
    `Artifact: ${literal(plan.path)} · Revision hash: ${literal(plan.hash)}`,
  ];
  if (integer(plan.current_revision)) lines.push(`Current revision: ${plan.current_revision}${plan.current_revision !== plan.revision ? ' · This is a historical revision; it does not authorize execution.' : ''}`);
  if (record(plan.origin)) lines.push(`Origin session: ${literal(plan.origin.session_id)} · Call: ${literal(plan.origin.call_id)}`);
  if (record(plan.reopening)) lines.push(`Reopened from revision ${escape(plan.reopening.source_revision)} · Source hash: ${literal(plan.reopening.source_hash)} · Intent: ${escape(plan.reopening.intent)}\n\nReason: ${escape(plan.reopening.reason)}`);
  return lines.join('\n\n');
}
function reviewBlocks(plan) {
  if (!Array.isArray(plan.comments) || !Array.isArray(plan.decisions)) return undefined;
  const content = [block('\n\n### Owner review feedback\n\n')];
  if (!plan.decisions.length) content.push(block('No owner decision recorded for this revision.\n\n'));
  for (const decision of plan.decisions) {
    if (!record(decision) || !['approve', 'reject'].includes(decision.decision)) return undefined;
    content.push(block(`${decision.decision === 'approve' ? 'Approved' : 'Rejected'} by owner · revision ${escape(decision.revision)} · Hash: ${literal(decision.hash)} · Owner session: ${literal(decision.owner_session_id)} · ${escape(decision.created_at)}\n\n`));
  }
  const comments = plan.comments.filter(comment => comment?.status !== 'deleted');
  if (!comments.length) content.push(block('No review comments.'));
  for (const comment of comments) {
    if (!record(comment) || typeof comment.text !== 'string') return undefined;
    const range = comment.line_start === comment.line_end ? `line ${escape(comment.line_start)}` : `lines ${escape(comment.line_start)}–${escape(comment.line_end)}`;
    const status = comment.status === 'draft' ? 'Draft' : comment.status === 'sent' ? 'Sent' : escape(comment.status);
    content.push(block(`\n\n**Comment on source ${range} · ${status}**\n\nComment: ${literal(comment.comment_id)} · Revision: ${escape(comment.revision)} · Hash: ${literal(comment.hash)} · Owner session: ${literal(comment.owner_session_id)}\n\n`), block(comment.text));
    if (typeof comment.quoted_context === 'string') content.push(block(`\n\nQuoted source:\n\n${quotedSource(comment.quoted_context)}`));
  }
  if (record(plan.closure)) {
    if (typeof plan.closure.reason !== 'string') return undefined;
    content.push(block(`\n\n### Closure\n\nOutcome: ${escape(plan.closure.outcome)} · ${escape(plan.closure.closed_at)}\n\nReason:\n\n`), block(plan.closure.reason));
    if (typeof plan.closure.evidence === 'string') content.push(block('\n\nEvidence:\n\n'), block(plan.closure.evidence));
  }
  return content;
}
function readView(plan) {
  if (typeof plan.content !== 'string' || !integer(plan.line_start) || !integer(plan.total_lines)
    || !(plan.line_end === null || integer(plan.line_end))) return undefined;
  const reviews = reviewBlocks(plan);
  if (!reviews) return undefined;
  const window = plan.line_end === null
    ? `No source lines returned at offset ${plan.line_start}; the artifact has ${plan.total_lines} lines.`
    : `Source lines ${plan.line_start}–${plan.line_end} of ${plan.total_lines}${plan.line_start > 1 || plan.line_end < plan.total_lines ? ' · Bounded source window; other lines are not included.' : ''}`;
  return { card: 'generic', title: `${identity(plan)} · ${statuses[plan.status]} · Execution ${plan.execution_authorized ? 'authorized' : 'not authorized'}`,
    // Never re-read, re-slice, trim, or escape the returned source window. A
    // separate block keeps the bounded Markdown byte-for-byte intact for UIs.
    content: [block(`${header(plan)}\n\n${window}\n\n`), block(plan.content), ...reviews] };
}
export function managedPlanCallView(name, args) {
  try {
    const id = integer(args?.plan_id) ? ` · Plan ${args.plan_id}` : '';
    const revision = integer(args?.revision) ? ` · revision ${args.revision}` : integer(args?.expected_revision) ? ` · expected revision ${args.expected_revision}` : '';
    const view = { card: 'generic', title: `${actions[name] ?? 'Managed plan'}${id}${revision}`, kind: ['plan_list', 'plan_read'].includes(name) ? 'read' : 'edit' };
    if (['plan_stage', 'exit_plan_mode'].includes(name)) view.content = [block(`Category: ${categories[args?.category ?? 'tasks'] ?? 'Unknown'} · Owner review required. Submission does not authorize execution.`)];
    if (name === 'plan_reopen') view.content = [block('Exact-copy staging only. Previous approvals and closure do not transfer; new owner review is required. Reopening never authorizes execution.')];
    return view;
  } catch { return undefined; }
}
export function managedPlanResultView(name, args, result) {
  // Projection/replay failures must never turn a successful operation into an
  // error. Unknown shapes and all failed results retain the native visible text.
  try {
    const data = parseResult(result);
    if (name === 'plan_list') {
      if (!Array.isArray(data) || !data.every(isSummary)) return undefined;
      return { card: 'generic', title: `Managed plans · ${data.length} plan${data.length === 1 ? '' : 's'}`,
        content: [block(data.length ? data.map(header).join('\n\n---\n\n') : 'No managed plans match this request.')] };
    }
    if (!isSummary(data)) return undefined;
    if (name === 'plan_read') return readView(data);
    const content = [block(header(data))];
    if (['plan_stage', 'plan_reopen', 'exit_plan_mode'].includes(name)) {
      if (typeof data.waiting_for_owner !== 'boolean' || typeof data.next_action !== 'string') return undefined;
      content.push(block(`\n\nWaiting for owner: ${data.waiting_for_owner ? 'Yes' : 'No'}\n\n${data.next_action}`));
      if (typeof data.initial_cwd === 'string') content.push(block(`\n\nInitial workspace: ${literal(data.initial_cwd)}`));
      return { card: 'generic', title: `${identity(data)} · Staged for owner review · Execution not authorized`, content };
    }
    if (name === 'plan_close') {
      if (typeof args?.reason !== 'string' || typeof args?.evidence !== 'string') return undefined;
      content.push(block(`\n\nOutcome: ${escape(args.outcome)}\n\nRecorded reason:\n\n`), block(args.reason), block('\n\nRecorded evidence:\n\n'), block(args.evidence));
      return { card: 'generic', title: `${identity(data)} · Closed · Execution not authorized`, content };
    }
    return undefined;
  } catch { return undefined; }
}
export function managedPlanPresentation(name) {
  return { presentCall: args => managedPlanCallView(name, args), presentResult: (args, result) => managedPlanResultView(name, args, result) };
}
