export const name = 'alex-managed-plans-tui'
export const inject = ['tuiScenes', 'managedPlans']
export const sceneId = 'alex-plan-artifacts'
const destinations = [
  { value: 'tasks', label: 'Tasks' }, { value: 'backlog', label: 'Backlog' },
  { value: 'blocked', label: 'Blocked' }, { value: 'para-o-dono', label: 'Owner decisions' },
  { value: 'closed', label: 'Closed (archive, not completion)' },
]

// No React/renderer imports: the scene belongs to the host reconciler.
export function PlanArtifactsScene({ React, ui, channel, close }) {
  const h = React.createElement
  const { Box, Text, ScrollBox, Markdown } = ui
  const { rows, columns } = ui.useTerminalSize()
  const [screen, setScreen] = React.useState('list')
  const [plans, setPlans] = React.useState([])
  const [index, setIndex] = React.useState(0)
  const [artifact, setArtifact] = React.useState(null)
  const [history, setHistory] = React.useState([])
  const [historyIndex, setHistoryIndex] = React.useState(0)
  const [focus, setFocus] = React.useState('document')
  const [line, setLine] = React.useState(1)
  const [composer, setComposerState] = React.useState(null)
  const composerRef = React.useRef(null)
  function setComposer(value) {
    // Input events in one terminal packet may precede the next React commit.
    composerRef.current = value
    setComposerState(value)
  }
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [stale, setStale] = React.useState(false)
  const [confirmation, setConfirmation] = React.useState(null)
  const lock = React.useRef(false)
  const alive = React.useRef(true)
  const drafts = React.useRef(new Map())
  const organizeRequests = React.useRef(new Map())
  const [organization, setOrganizationState] = React.useState(null)
  const organizationRef = React.useRef(null)
  function setOrganization(value) {
    organizationRef.current = value
    setOrganizationState(value)
  }
  const preview = React.useRef(null)
  const [, updateDrafts] = React.useState(0)
  const selected = plans[index - 1]
  const source = artifact?.content ?? ''
  const blocks = React.useMemo(() => source ? ui.markdownSourceBlocks(source) : [], [source])
  const blockIndex = Math.max(0, blocks.findIndex(block => line >= block.startLine && line <= block.endLine))
  const range = blocks[blockIndex]
  const identity = value => ({ plan_id: value.plan_id, revision: value.revision, hash: value.hash })
  const draftKey = value => `${value.plan_id}:${value.revision}:${value.hash}`
  const current = artifact && artifact.revision === artifact.current_revision
  const commentable = current && artifact.status === 'staged' && !stale
  const matchingComment = range && (artifact?.comments ?? []).find(comment =>
    comment.status !== 'deleted' && comment.revision === artifact.revision && comment.hash === artifact.hash &&
    comment.line_start <= range.endLine && range.startLine <= comment.line_end)
  const wide = columns >= 96
  const navigation = React.useMemo(() => ({
    line, scrollRef: preview,
    commentLines: (artifact?.comments ?? []).filter(comment => comment.status !== 'deleted').map(comment => comment.line_start),
    onSelect: value => { if (!lock.current && !confirmation) { setLine(value.startLine); setFocus('document') } },
  }), [line, artifact, confirmation])

  async function request(payload) {
    const outcome = await channel.runExternalCommandOutcome('plan', ' ui ' + JSON.stringify(payload))
    if (!outcome) throw new Error('Command unavailable. Reopen /plan when the session is ready.')
    if (outcome.kind !== 'success') throw new Error(outcome.text || 'The operation failed.')
    let result
    try { result = JSON.parse(outcome.text) } catch { throw new Error('Invalid plan command response.') }
    if (result.ok !== true) throw new Error(result.error?.message || result.error || 'The operation was not confirmed.')
    return result.data
  }

  // One operation at a time; detached responses cannot mutate an unmounted scene.
  async function run(operation) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try { await operation() } catch (cause) {
      if (alive.current) {
        setError(String(cause?.message ?? cause) + ' · Press r to reload. Drafts are preserved.')
        setStale(true)
      }
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }

  async function loadList(preferred = selected?.plan_id) {
    const data = await request({ action: 'list' })
    if (!Array.isArray(data)) throw new Error('Invalid plan list.')
    if (!alive.current) return
    const group = item => item.pending_review ? 0 : ['staged', 'rejected'].includes(item.status) ? 1 : item.status === 'closed' ? 6 : ({ tasks: 2, blocked: 3, backlog: 4, 'para-o-dono': 5 }[item.category] ?? 6)
    const sorted = [...data].sort((a, b) => group(a) - group(b) || Number(b.plan_id) - Number(a.plan_id))
    setPlans(sorted)
    const found = sorted.findIndex(item => item.plan_id === preferred)
    setIndex(found >= 0 ? found + 1 : sorted.some(item => item.pending_review) ? 1 : 0)
    setStale(false)
  }

  async function readPlan(value, revision = value.revision) {
    const [data, revisions] = await Promise.all([
      request({ action: 'read', plan_id: value.plan_id, revision }),
      request({ action: 'history', plan_id: value.plan_id }),
    ])
    if (!data || typeof data.content !== 'string' || !Number.isInteger(data.revision) || typeof data.hash !== 'string' || data.total_lines !== data.content.split('\n').length || (data.offset !== undefined && data.offset !== 1)) {
      throw new Error('The plan is missing complete source or revision identity.')
    }
    if (!Array.isArray(revisions)) throw new Error('Invalid revision history.')
    if (!alive.current) return
    setArtifact(data)
    setHistory(revisions)
    setHistoryIndex(Math.max(0, revisions.findIndex(item => item.revision === data.revision)))
    const nextBlocks = ui.markdownSourceBlocks(data.content)
    setLine(previous => nextBlocks.find(block => previous >= block.startLine && previous <= block.endLine)?.startLine ?? nextBlocks[0]?.startLine ?? 1)
    setScreen('view')
    setFocus('document')
    setStale(false)
    setNotice('')
  }

  React.useEffect(() => {
    alive.current = true
    void run(() => loadList())
    return () => { alive.current = false }
  }, [])

  function remember(value) {
    drafts.current.set(value.key, value)
    updateDrafts(version => version + 1)
  }

  function startComment() {
    if (!commentable || !range) {
      setNotice('Read-only revision. Open the current staged revision to comment.')
      return
    }
    // Clicking a commented block edits its original anchor, not a new visual row.
    const anchor = matchingComment ? ui.markdownSourceRange(source, matchingComment.line_start, matchingComment.line_end) : range
    const key = `${draftKey(artifact)}:${anchor.startLine}:${anchor.endLine}`
    setComposer(drafts.current.get(key) ?? {
      key, kind: 'comment', ...identity(artifact), line_start: anchor.startLine,
      line_end: anchor.endLine, quote: anchor.quote, text: matchingComment?.text ?? '',
      ...(matchingComment?.comment_id ? { comment_id: matchingComment.comment_id } : {}),
    })
    setScreen('compose')
  }

  function startNew() {
    if ([...drafts.current.values()].some(value => value.kind === 'comment')) {
      setError('Save or discard unsaved comments before creating a new plan.')
      return
    }
    setComposer(drafts.current.get('new') ?? { key: 'new', kind: 'new', text: '' })
    setScreen('compose')
  }

  async function saveComposer() {
    const value = composerRef.current
    if (!value.text.trim()) { setError('Enter text to save, or press Ctrl+X to discard.'); return }
    remember(value)
    await run(async () => {
      if (value.kind === 'new') {
        await request({ action: 'new', request: value.text })
        if (!alive.current) return
        drafts.current.delete(value.key)
        close()
      } else {
        await request({ action: 'comment', ...identity(value), line_start: value.line_start, line_end: value.line_end, text: value.text, ...(value.comment_id ? { comment_id: value.comment_id } : {}) })
        if (!alive.current) return
        drafts.current.delete(value.key)
        setComposer(null)
        setScreen('view')
        await readPlan(value)
        setNotice('Comment saved as a draft. Nothing sent to the agent.')
      }
    })
  }

  function startDelete() {
    if (!commentable || !matchingComment || matchingComment.status !== 'draft') {
      setNotice('Only saved draft comments on the current staged revision can be deleted.')
      return
    }
    if (drafts.current.size) { setError('Save or discard unsaved text before deleting a comment.'); return }
    setConfirmation({ ...identity(artifact), comment_id: matchingComment.comment_id,
      line_start: matchingComment.line_start, line_end: matchingComment.line_end })
    setError('')
    setNotice('')
  }

  function startOrganize(value) {
    if (drafts.current.size) { setError('Save or discard unsaved text before moving a plan.'); return }
    if (stale) { setError('Reload with r before moving this revision.'); return }
    if (value.current_revision !== undefined && value.revision !== value.current_revision) {
      setNotice('Open the current revision before moving the plan.')
      return
    }
    setError('')
    setOrganization({ value, index: value.status === 'closed' ? 4 : Math.max(0, destinations.findIndex(item => item.value === value.category)) })
  }

  async function saveOrganization() {
    const { value, index: choice } = organizationRef.current
    const category = destinations[choice].value
    await run(async () => {
      const key = `${draftKey(value)}:${category}`
      if (!organizeRequests.current.has(key)) organizeRequests.current.set(key, globalThis.crypto.randomUUID())
      const moved = await request({ action: 'organize', plan_id: value.plan_id, expected_revision: value.revision,
        hash: value.hash, category, request_id: organizeRequests.current.get(key) })
      if (!alive.current) return
      setOrganization(null)
      if (screen === 'list') await loadList(moved.plan_id)
      else await readPlan(moved)
      organizeRequests.current.delete(key)
      setNotice(moved.notice || (moved.reopened ? 'New revision awaiting approval.' : `Destination set to ${category}.`))
    })
  }

  ui.useInput((input, key) => {
    if (lock.current) return
    if (confirmation) {
      if (input.toLowerCase() === 'n' || key.escape) { setConfirmation(null); setNotice('Deletion cancelled.'); return }
      if (input.toLowerCase() === 'y') {
        const value = confirmation
        void run(async () => {
          await request({ action: 'delete_comment', ...identity(value), comment_id: value.comment_id })
          if (!alive.current) return
          setConfirmation(null)
          await readPlan(value)
          setNotice('Draft comment deleted. Nothing sent to the agent; audit history retained.')
        })
      }
      return
    }
    if (organizationRef.current) {
      const value = organizationRef.current
      if (key.escape) { setOrganization(null); return }
      if (key.upArrow || input === 'k') setOrganization({ ...value, index: Math.max(0, value.index - 1) })
      else if (key.downArrow || input === 'j') setOrganization({ ...value, index: Math.min(destinations.length - 1, value.index + 1) })
      else if (key.return) void saveOrganization()
      return
    }
    if (screen === 'compose') {
      const value = composerRef.current
      if (key.escape) {
        if (value.kind === 'comment' && value.text.trim()) { void saveComposer(); return }
        if (value.text) remember(value)
        setScreen(value.kind === 'new' ? 'list' : 'view')
        setNotice(value.text ? 'Unsaved text retained. Reopen with c to continue, or Ctrl+X to discard.' : '')
        return
      }
      if (key.ctrl && input === 'x') {
        drafts.current.delete(value.key)
        setScreen(value.kind === 'new' ? 'list' : 'view')
        setComposer(null)
        setNotice('Unsaved text discarded.')
        return
      }
      if (key.return && !key.isPasted) {
        if (key.shift || key.meta) setComposer({ ...value, text: value.text + '\n' })
        else void saveComposer()
        return
      }
      if (key.ctrl && input === 'j') { setComposer({ ...value, text: value.text + '\n' }); return }
      if (key.backspace || key.delete) {
        const points = Array.from(value.text)
        points.pop()
        setComposer({ ...value, text: points.join('') })
        return
      }
      if (input && (key.isPasted || (!key.ctrl && !key.meta)) && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        setComposer({ ...value, text: value.text + input.replace(/\r\n?/g, '\n') })
      }
      return
    }
    if (key.escape) {
      if (screen === 'view') {
        if (focus === 'history') { setFocus('document'); return }
        setScreen('list')
        return
      }
      if (drafts.current.size) { setError('Unsaved text remains. Reopen the composer to save or discard it before closing.'); return }
      close()
      return
    }
    if (input === 'r') {
      void run(() => screen === 'list' ? loadList() : readPlan(artifact))
      return
    }
    if (input.toLowerCase() === 'o' && (screen === 'list' ? selected : artifact)) {
      startOrganize(screen === 'list' ? selected : artifact)
      return
    }
    if (screen === 'list') {
      if (key.upArrow || input === 'k') setIndex(value => Math.max(0, value - 1))
      else if (key.downArrow || input === 'j') setIndex(value => Math.min(plans.length, value + 1))
      else if (key.return) {
        if (!selected) startNew()
        else { setLine(1); void run(() => readPlan(selected)) }
      } else if ((input === 'y' || input === 'n') && selected?.pending_review && selected.status === 'staged') {
        if (stale) { setError('Reload with r before deciding on this revision.'); return }
        if (drafts.current.size) { setError('Save or discard unsaved text before deciding.'); return }
        const decision = input === 'y' ? 'approve' : 'reject'
        void run(async () => {
          const outcome = await request({ action: 'decide', ...identity(selected), category: selected.category, decision })
          if (!alive.current) return
          await loadList(selected.plan_id)
          if (!alive.current) return
          setNotice(decision === 'approve' && selected.category === 'tasks' && outcome.goal_resume
            ? `Approved. ${outcome.goal_resume.message}`
            : outcome.notice || (decision === 'reject' ? 'Rejection recorded. Saved comments sent; without comments, the agent waits.' : selected.category === 'tasks' ? 'Revision approved for execution.' : 'Plan saved. Execution not authorized.'))
        })
      }
      return
    }
    if (key.leftArrow) { setFocus('history'); return }
    if (key.rightArrow) { setFocus('document'); return }
    if (focus === 'history') {
      if (key.upArrow || input === 'k') setHistoryIndex(value => Math.max(0, value - 1))
      else if (key.downArrow || input === 'j') setHistoryIndex(value => Math.min(history.length - 1, value + 1))
      else if (key.return && history[historyIndex]) void run(() => readPlan(history[historyIndex]))
      return
    }
    if (key.upArrow || input === 'k') setLine(blocks[Math.max(0, blockIndex - 1)]?.startLine ?? 1)
    else if (key.downArrow || input === 'j') setLine(blocks[Math.min(blocks.length - 1, blockIndex + 1)]?.startLine ?? 1)
    else if (key.home) setLine(blocks[0]?.startLine ?? 1)
    else if (key.end) setLine(blocks.at(-1)?.startLine ?? 1)
    else if (input === 'c') startComment()
    else if (input === 'd') startDelete()
    else if (key.pageDown) preview.current?.scrollBy(Math.max(1, rows - 8))
    else if (key.pageUp) preview.current?.scrollBy(-Math.max(1, rows - 8))
  })

  const text = (value, props = {}) => h(Text, props, value)
  // Text is not a layout node; nonshrinking chrome belongs to Box wrappers.
  const fixed = (...children) => h(Box, { flexDirection: 'column', flexShrink: 0 }, ...children)
  const feedback = fixed(
    confirmation ? text(`Delete draft comment at L${confirmation.line_start}–${confirmation.line_end}? y delete · n / Esc cancel`, { color: 'warning', wrap: 'truncate-end' }) : null,
    busy ? text('Working…', { color: 'subtle' }) : null,
    error ? text(error, { color: 'error', wrap: 'truncate-end' }) : null,
    notice ? text(notice, { color: 'subtle', wrap: 'truncate-end' }) : null,
  )
  const revisionRows = () => {
    const capacity = Math.max(1, rows - 9)
    const start = Math.max(0, historyIndex - Math.floor(capacity / 2))
    return history.slice(start, start + capacity).map((item, offset) => h(Box, {
      key: item.revision, flexDirection: 'column', flexShrink: 0,
      onClick: () => { if (!lock.current) { setHistoryIndex(start + offset); setFocus('history') } },
    }, text(`${start + offset === historyIndex && focus === 'history' ? '›' : ' '} r${item.revision} · ${item.status}${item.is_current ? ' · current' : ''}`, { bold: item.revision === artifact.revision, wrap: 'truncate-end' }),
    text(`  ${item.comment_count} comment${item.comment_count === 1 ? '' : 's'}`, { color: 'subtle', wrap: 'truncate-end' })))
  }
  let body
  let help
  if (organization) {
    const { value, index: choice } = organization
    const category = destinations[choice].value
    const hint = category === 'closed' ? 'Archive only; this does not mark work completed.'
      : value.status === 'closed' || (value.imported && category === 'tasks') ? 'A fresh revision will require approval; history stays intact.'
      : value.status === 'staged' || value.status === 'rejected' ? 'Changes the proposed destination; no approval is granted.'
      : 'Changes organization only; no goal is resumed.'
    body = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      fixed(text(`Move plan #${value.plan_id} r${value.revision}`, { bold: true }),
        text(`Current: ${value.status} → ${value.category}`, { color: 'subtle', wrap: 'truncate-end' })),
      ...destinations.map((item, position) => h(Box, { key: item.value, flexShrink: 0,
        onClick: () => { if (!lock.current) setOrganization({ ...organizationRef.current, index: position }) } },
        text(`${choice === position ? '›' : ' '} ${item.label}`, { bold: choice === position, wrap: 'truncate-end' }))),
      fixed(text(hint, { color: 'warning', wrap: 'truncate-end' })))
    help = '↑↓ destination · Enter move · Esc cancel'
  } else if (screen === 'list') {
    const capacity = Math.max(1, rows - 8)
    const start = Math.max(0, index - Math.floor(capacity / 2))
    const entries = [{ new: true }, ...plans]
    body = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      ...entries.slice(start, start + capacity).map((item, offset) => {
        const position = start + offset
        const label = item.new ? 'New plan' : `${item.pending_review ? 'STAGING' : item.status} → ${item.category} · #${item.plan_id} r${item.revision} · ${item.title}`
        return h(Box, { key: position, flexShrink: 0, onClick: () => { if (!lock.current) setIndex(position) } },
          text(`${position === index ? '›' : ' '} ${label}`, { bold: position === index, wrap: 'truncate-end' }))
      }),
      selected ? fixed(text(`${selected.path ?? ''} · ${selected.pending_review ? selected.category === 'tasks' ? 'y approves and resumes a paused/blocked session goal; n requests revision.' : 'y saves only, without execution; n requests revision.' : 'No pending decision.'}`, { color: 'subtle', wrap: 'truncate-end' })) : null,
    )
    help = '↑↓ · Enter open · O move · y approve/resume · n reject · r · Esc'
  } else if (screen === 'compose') {
    body = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      fixed(text(composer.kind === 'new' ? 'New plan · request' : `${composer.comment_id ? 'Edit' : 'Add'} comment · #${composer.plan_id} r${composer.revision} · L${composer.line_start}–${composer.line_end}`, { bold: true }),
        composer.quote ? text(composer.quote, { color: 'subtle', wrap: 'truncate-end' }) : null),
      h(ScrollBox, { flexDirection: 'column', flexGrow: 1, stickyScroll: true },
        h(Box, { flexDirection: 'column', flexShrink: 0 }, text(composer.text + '▏'))),
      fixed(text('Edit at the end of the text. Saving a comment does not send it to the agent.', { color: 'subtle', wrap: 'truncate-end' })),
    )
    help = composer.kind === 'new' ? 'Enter send request · Ctrl+J newline · Esc keep draft · Ctrl+X discard' : 'Enter / Esc save draft and return · Ctrl+J newline · Ctrl+X discard'
  } else {
    const revisions = h(Box, { flexDirection: 'column', width: wide ? 28 : undefined, flexShrink: 0, overflow: 'hidden' },
      fixed(text('Revisions', { bold: true }), text('Enter opens · → document', { color: 'subtle' })), ...revisionRows())
    const document = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      // Vertical scroll content must not be stretched into a row-axis viewport.
      h(ScrollBox, { ref: preview, flexDirection: 'column', flexGrow: 1, flexShrink: 1 },
        h(Box, { flexDirection: 'column', flexShrink: 0 }, h(Markdown, { preserveSource: true, sourceNavigation: navigation }, source))),
      fixed(text(`${current ? 'Current' : 'Historical'} revision · ${artifact.status} · ${range ? `L${range.startLine}–${range.endLine}` : 'No source block'}${commentable ? ' · c to comment' : ' · read-only'}`, { color: 'subtle', wrap: 'truncate-end' }),
        matchingComment ? text(`Comment · L${matchingComment.line_start}–${matchingComment.line_end} · ${matchingComment.status}: ${matchingComment.text}`, { color: 'subtle', wrap: 'truncate-end' }) : null),
    )
    body = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      fixed(text(`#${artifact.plan_id} r${artifact.revision} → ${artifact.category} · ${artifact.title ?? ''}`, { bold: true, wrap: 'truncate-end' })),
      h(Box, { flexDirection: 'row', flexGrow: 1, overflow: 'hidden' },
        wide || focus !== 'history' ? document : null,
        wide || focus === 'history' ? revisions : null),
    )
    help = focus === 'history' ? '↑↓ select revision · Enter open · → / Esc document' : 'O move · c comment · d delete · ← history · Wheel scroll · Esc list'
  }
  return h(Box, { flexDirection: 'column', height: rows, overflow: 'hidden' },
    fixed(text('Plans · .plan artifacts · not native Plan mode', { bold: true })), body, feedback,
    fixed(text(help, { color: 'subtle', wrap: 'truncate-end' })))
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposeScene = ctx.tuiScenes.register({ id: sceneId, title: 'Managed plans', component: PlanArtifactsScene }, ctx)
    let disposeOpener
    try {
      disposeOpener = ctx.managedPlans.registerBrowserOpener((_agent) => {
        if (!ctx.tuiScenes.open(sceneId)) throw new Error('The plan scene is unavailable.')
      })
    } catch (error) {
      disposeScene()
      throw error
    }
    return () => { disposeOpener(); disposeScene() }
  })
}
