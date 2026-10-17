# Companion Instructions and Skills

## Objective
Review ~/.dsh/AGENTS-Companion.md and create practical session and research guides in /home/alex/git/my/dsh-companion-workspace/.agents/skills, with valid JSON examples and concrete scenarios, without changing models, permissions, or services, or performing real interventions.

## Discovery
/home/alex/.dsh/Companion/AGENTS.md is a symlink to ../AGENTS-Companion.md, not a copy. The profile configures agent-instructions.dshHome in that directory and the SDK fixes the global name AGENTS.md. Preserve the required link instead of deleting and breaking loading; edit only the original. The native skills provider discovers .agents/skills in the project.

## Work
1. Review existing instructions preserving rules for goals, limits, and approvals; require reading the relevant skill, checking actual capabilities before claiming impossibility, and distinguishing between write/read/send locks.
2. companion-sessions skill: list/find/read/context; IDs/titles; scenarios with open terminal holding writer, investigating test/error/JSON, pagination, partial historical search, send versus resume, and creation currently Companion (do not promise dsh-tui). Examples matching current schemas.
3. companion-research skill: verifiable question, competing hypotheses, evidence plan, distinct relevant sources, reading/continuation in the same run, counter-evidence, handling blocks/quotas, and stopping criteria. Examples for technical error, release, and community experience; do not demand indiscriminate fanout.
4. Validate discovery of both SKILL.md files by the SDK provider, session examples via parser, and research via current schema; review obvious scenarios and ambiguities. Record local evidence in .dumps. Do not send messages, create sessions, search the network, or restart services to validate.

## Conclusion
Loadable guides and concise instructions pointing to them; report the preserved link and distinguish discovery validation from model behavior guarantees in production.
