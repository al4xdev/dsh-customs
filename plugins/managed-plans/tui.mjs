export const name = 'alex-managed-plans-tui'
export const inject = ['tuiScenes', 'managedPlans']
export const sceneId = 'alex-plan-artifacts'

// No React/renderer imports: the scene belongs to the host reconciler.
export function PlanArtifactsScene({ React, ui, channel, close }) {
  const h = React.createElement
  const { Box, Text, ScrollBox, Markdown } = ui
  const { rows } = ui.useTerminalSize()
  const [screen, setScreen] = React.useState('list')
  const [plans, setPlans] = React.useState([])
  const [index, setIndex] = React.useState(0)
  const [artifact, setArtifact] = React.useState(null)
  const [line, setLine] = React.useState(1)
  const [endLine, setEndLine] = React.useState(null)
  const [composer, setComposer] = React.useState(null)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [stale, setStale] = React.useState(false)
  const lock = React.useRef(false)
  const alive = React.useRef(true)
  const drafts = React.useRef(new Map())
  const preview = React.useRef(null)
  const commentsScroll = React.useRef(null)
  const [, updateDrafts] = React.useState(0)
  const selected = plans[index - 1]
  const source = artifact?.content ?? ''
  const lines = source.split('\n')
  const range = artifact && ui.markdownSourceRange(source, Math.min(line, endLine ?? line), Math.max(line, endLine ?? line))
  const draftKey = (value) => `${value.plan_id}:${value.revision}:${value.hash}`
  const identity = (value) => ({ plan_id: value.plan_id, revision: value.revision, hash: value.hash })

  async function request(payload) {
    const outcome = await channel.runExternalCommandOutcome('plan', 'ui ' + JSON.stringify(payload))
    if (!outcome) throw new Error('Comando indisponível. Reabra /plan quando a sessão estiver pronta.')
    if (outcome.kind !== 'success') throw new Error(outcome.text || 'A operação falhou.')
    let result
    try { result = JSON.parse(outcome.text) } catch { throw new Error('Resposta inválida do comando plan.') }
    if (result.ok !== true) throw new Error(result.error?.message || result.error || 'A operação não foi confirmada.')
    return result.data
  }

  // One operation at a time; detached responses cannot mutate an unmounted scene.
  async function run(operation) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try { await operation() } catch (cause) {
      if (alive.current) {
        setError(String(cause?.message ?? cause) + ' · r recarrega; rascunhos são preservados.')
        // Any failed mutation may be a stale revision. Require an explicit read
        // before another decision rather than guessing based on error wording.
        setStale(true)
      }
    } finally {
      lock.current = false
      if (alive.current) setBusy(false)
    }
  }

  async function loadList(preferred = selected?.plan_id) {
    const data = await request({ action: 'list' })
    if (!Array.isArray(data)) throw new Error('A lista de planos não é válida.')
    if (!alive.current) return
    const group = (item) => item.pending_review ? 0 : ['staged', 'rejected'].includes(item.status) ? 1 : item.status === 'closed' ? 5 : ({ tasks: 2, backlog: 3, 'para-o-dono': 4 }[item.category] ?? 5)
    const sorted = [...data].sort((a, b) => group(a) - group(b) || Number(b.plan_id) - Number(a.plan_id))
    setPlans(sorted)
    const found = sorted.findIndex((item) => item.plan_id === preferred)
    setIndex(found >= 0 ? found + 1 : sorted.some((item) => item.pending_review) ? 1 : 0)
    setStale(false)
  }

  async function readPlan(value) {
    const data = await request({ action: 'read', plan_id: value.plan_id })
    if (!data || typeof data.content !== 'string' || !Number.isInteger(data.revision) || typeof data.hash !== 'string' || data.total_lines !== data.content.split('\n').length || (data.offset !== undefined && data.offset !== 1)) {
      throw new Error('O plano não contém fonte completa e identidade de revisão.')
    }
    if (!alive.current) return
    setArtifact(data)
    setLine((current) => Math.max(1, Math.min(current, data.content.split('\n').length)))
    setEndLine(null)
    setScreen('view')
    setStale(false)
    preview.current?.scrollTo(0)
  }

  React.useEffect(() => {
    alive.current = true
    void run(() => loadList())
    return () => { alive.current = false }
  }, [])

  function remember(value) {
    drafts.current.set(value.key, value)
    updateDrafts((version) => version + 1)
  }

  function startComment() {
    const key = `${draftKey(artifact)}:${range.startLine}:${range.endLine}`
    const saved = (artifact.comments ?? []).find((comment) => comment.revision === artifact.revision && comment.hash === artifact.hash && comment.line_start === range.startLine && comment.line_end === range.endLine)
    const value = drafts.current.get(key) ?? {
      key, kind: 'comment', ...identity(artifact), line_start: range.startLine,
      line_end: range.endLine, quote: range.quote, text: saved?.text ?? '',
      ...(saved?.comment_id ? { comment_id: saved.comment_id } : {}),
    }
    setComposer(value)
    setScreen('compose')
  }

  function startNew() {
    if ([...drafts.current.values()].some((value) => value.kind === 'comment')) {
      setError('Salve ou descarte os comentários não salvos antes de criar um novo plano.')
      return
    }
    setComposer(drafts.current.get('new') ?? { key: 'new', kind: 'new', text: '' })
    setScreen('compose')
  }

  async function saveComposer() {
    const value = composer
    if (!value.text.trim()) { setError('Escreva o texto antes de salvar; Ctrl+X descarta explicitamente.'); return }
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
        setNotice('Comentário salvo como rascunho. Nada enviado ao agente.')
        // The save is already durable even if this refresh fails.
        setScreen('view')
        await readPlan(value)
      }
    })
  }

  ui.useInput((input, key) => {
    if (lock.current) return
    if (screen === 'compose') {
      if (key.escape) {
        if (composer.text) remember(composer)
        setScreen(composer.kind === 'new' ? 'list' : 'view')
        setNotice('Texto não salvo preservado nesta tela; reabra o compositor para salvar ou Ctrl+X para descartar.')
        return
      }
      if (key.ctrl && input === 'x') {
        drafts.current.delete(composer.key)
        setScreen(composer.kind === 'new' ? 'list' : 'view')
        setComposer(null)
        setNotice('Texto não salvo descartado explicitamente.')
        return
      }
      if (key.return && !key.isPasted) {
        if (key.shift || key.meta) setComposer({ ...composer, text: composer.text + '\n' })
        else void saveComposer()
        return
      }
      if (key.ctrl && input === 'j') { setComposer({ ...composer, text: composer.text + '\n' }); return }
      if (key.backspace || key.delete) {
        const points = Array.from(composer.text)
        points.pop()
        setComposer({ ...composer, text: points.join('') })
        return
      }
      if (input && (key.isPasted || (!key.ctrl && !key.meta)) && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
        setComposer({ ...composer, text: composer.text + input.replace(/\r\n?/g, '\n') })
      }
      return
    }
    if (key.escape) {
      if (screen === 'view') { setScreen('list'); return }
      if (drafts.current.size) { setError('Há texto não salvo. Reabra o comentário/Novo plano e salve ou descarte com Ctrl+X antes de fechar.'); return }
      close()
      return
    }
    if (input === 'r') {
      void run(() => screen === 'list' ? loadList() : readPlan(artifact))
      return
    }
    if (screen === 'list') {
      if (key.upArrow || input === 'k') setIndex((current) => Math.max(0, current - 1))
      else if (key.downArrow || input === 'j') setIndex((current) => Math.min(plans.length, current + 1))
      else if (key.return) {
        if (!selected) startNew()
        else { setLine(1); void run(() => readPlan(selected)) }
      } else if ((input === 'y' || input === 'n') && selected?.pending_review && selected.status === 'staged') {
        if (stale) { setError('Recarregue com r antes de decidir sobre esta revisão.'); return }
        if (drafts.current.size) { setError('Salve ou descarte o texto não salvo antes de decidir.'); return }
        const decision = input === 'y' ? 'approve' : 'reject'
        void run(async () => {
          await request({ action: 'decide', ...identity(selected), decision })
          if (!alive.current) return
          setNotice(decision === 'reject' ? 'Rejeição registrada; só os rascunhos salvos são enviados. Sem comentários: aguarda instruções.' : selected.category === 'tasks' ? 'Revisão aprovada para execução.' : 'Plano salvo. Execução não autorizada.')
          await loadList(selected.plan_id)
        })
      }
      return
    }
    if (key.upArrow || input === 'k') { setLine((current) => Math.max(1, current - 1)); setEndLine(null) }
    else if (key.downArrow || input === 'j') { setLine((current) => Math.min(lines.length, current + 1)); setEndLine(null) }
    else if (input === '[') setEndLine((current) => Math.max(1, (current ?? line) - 1))
    else if (input === ']') setEndLine((current) => Math.min(lines.length, (current ?? line) + 1))
    else if (key.home) { setLine(1); setEndLine(null) }
    else if (key.end) { setLine(lines.length); setEndLine(null) }
    else if (input === 'c') startComment()
    else if (input === 'd') {
      const retained = [...drafts.current.values()].find((value) => value.kind === 'comment' && value.plan_id === artifact.plan_id)
      if (retained) { setComposer(retained); setScreen('compose') }
    }
    else if (key.pageDown || key.wheelDown) preview.current?.scrollBy(Math.max(1, rows - 12))
    else if (key.pageUp || key.wheelUp) preview.current?.scrollBy(-Math.max(1, rows - 12))
    else if (input === 'J') commentsScroll.current?.scrollBy(3)
    else if (input === 'K') commentsScroll.current?.scrollBy(-3)
  })

  const text = (value, props = {}) => h(Text, props, value)
  const header = text('Planos · .plan · Markdown somente leitura', { bold: true })
  const feedback = h(Box, { flexDirection: 'column', flexShrink: 0 },
    busy ? text('Aguarde…', { color: 'subtle' }) : null,
    error ? text(error, { color: 'error', wrap: 'truncate-end' }) : null,
    notice ? text(notice, { color: 'subtle', wrap: 'truncate-end' }) : null,
  )
  let body
  let help
  if (screen === 'list') {
    const capacity = Math.max(1, rows - 9)
    const start = Math.max(0, index - Math.floor(capacity / 2))
    const entries = [{ new: true }, ...plans]
    body = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      ...entries.slice(start, start + capacity).map((item, offset) => {
        const position = start + offset
        const label = item.new ? 'Novo plano' : `${item.pending_review ? 'STAGING' : item.status} → ${item.category} · #${item.plan_id} r${item.revision} · ${item.title}`
        return text(`${position === index ? '›' : ' '} ${label}`, { key: position, bold: position === index, wrap: 'truncate-end' })
      }),
      selected ? text(`${selected.path ?? ''} · ${selected.pending_review ? selected.category === 'tasks' ? 'y aprova esta revisão e inicia execução; n pede revisão.' : 'y salva apenas, sem execução; n pede revisão.' : 'Sem decisão pendente.'}`, { color: 'subtle' }) : null,
    )
    help = '↑↓ / j k navegar · Enter abrir · y/n só staging pendente · r atualizar · Esc fechar'
  } else if (screen === 'compose') {
    body = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      text(composer.kind === 'new' ? 'Novo plano · pedido' : `Comentário · #${composer.plan_id} r${composer.revision} · fonte ${composer.line_start}–${composer.line_end}`, { bold: true }),
      composer.quote ? text(composer.quote, { color: 'subtle', wrap: 'truncate-end' }) : null,
      h(ScrollBox, { flexGrow: 1, stickyScroll: true }, text(composer.text + '▏')),
      text('Edição no final do texto; Backspace remove o último caractere. Salvar comentário não envia ao agente.', { color: 'subtle' }),
    )
    help = 'Enter salvar · Ctrl+J / Shift+Enter nova linha · Esc cancelar e reter texto · Ctrl+X descartar'
  } else {
    const first = Math.max(1, line - 1)
    body = h(Box, { flexDirection: 'column', flexGrow: 1, overflow: 'hidden' },
      text(`#${artifact.plan_id} r${artifact.revision} → ${artifact.category} · ${artifact.title ?? ''}`, { bold: true, wrap: 'truncate-end' }),
      h(ScrollBox, { ref: preview, flexGrow: 1, flexShrink: 1 }, h(Markdown, { preserveSource: true }, source)),
      text(`FOCO NA FONTE ${range.startLine}–${range.endLine}/${lines.length} · não é uma linha visual · hash ${artifact.hash}`, { bold: true, wrap: 'truncate-end' }),
      ...lines.slice(first - 1, Math.min(lines.length, first + 2)).map((value, offset) => text(`${first + offset === line ? '›' : ' '} ${first + offset} │ ${value}`, { key: first + offset, wrap: 'truncate-end' })),
      text(`Trecho exato: ${JSON.stringify(range.quote)}`, { color: 'subtle', wrap: 'truncate-end' }),
      h(ScrollBox, { ref: commentsScroll, height: Math.min(3, Math.max(1, rows - 16)), flexShrink: 0 },
        ...(artifact.comments ?? []).map((comment, position) => text(`💬 r${comment.revision} L${comment.line_start}–${comment.line_end}${comment.revision !== artifact.revision || comment.hash !== artifact.hash ? ' [revisão antiga; não reancorado]' : ''}: ${comment.text}`, { key: comment.comment_id ?? position })),
        !(artifact.comments ?? []).length ? text('Sem comentários salvos.', { color: 'subtle' }) : null,
      ),
    )
    help = '↑↓ / j k fonte · [ ] intervalo · c comentar/editar · d retomar texto · PgUp/PgDn preview · J/K comentários · Esc lista'
  }
  return h(Box, { flexDirection: 'column', height: rows, overflow: 'hidden' }, header, body, feedback, text(help, { color: 'subtle', flexShrink: 0 }))
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposeScene = ctx.tuiScenes.register({ id: sceneId, title: 'Planos gerenciados', component: PlanArtifactsScene }, ctx)
    let disposeOpener
    try {
      disposeOpener = ctx.managedPlans.registerBrowserOpener((_agent) => {
        if (!ctx.tuiScenes.open(sceneId)) throw new Error('A cena de planos não está disponível.')
      })
    } catch (error) {
      disposeScene()
      throw error
    }
    return () => { disposeOpener(); disposeScene() }
  })
}
