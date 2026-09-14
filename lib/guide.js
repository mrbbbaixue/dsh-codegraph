/**
 * B1: the static CodeGraph guide injected as a system-prompt section.
 *
 * Derived from codegraph's own `SERVER_INSTRUCTIONS` playbook (the MCP
 * `initialize.instructions` payload), trimmed to roughly 1.5 KB and remapped
 * onto this plugin's two `core` tools. Kept in its own module so the wording can
 * be reviewed and edited without touching registration logic.
 *
 * @module @mrbbbaixue/dsh-codegraph/guide
 */

/**
 * The rendered guide text. Stable prose: the whole point of B1 is that the same
 * paragraphs reach every request, including subagent requests, which never see
 * MCP server instructions.
 */
export const CODEGRAPH_GUIDE = `# CodeGraph — pre-indexed code knowledge graph

CodeGraph is a pre-computed graph of every symbol and call edge in a project, built by the \`codegraph\` CLI. Reach for these tools BEFORE grep/glob/read to locate or understand code:

- \`codegraph_explore\` — PRIMARY, and Read-equivalent. Give it a natural-language question or a bag of symbol/file names. One capped call returns the verbatim, line-numbered source of the relevant symbols grouped by file — treat that source as already read — plus the call paths among them (including dynamic-dispatch hops grep cannot follow) and a blast-radius summary.
- \`codegraph_index\` — build or refresh the index (\`operation: init | sync | index\`). You rarely need it: the plugin builds a missing index on the first query and refreshes it before every one. \`init\` and \`index\` ask the user first.

A workspace with no \`.codegraph/\` index is neither a finding to report nor a reason to fall back to grep: the first \`codegraph_explore\` builds the index automatically. Only when it still answers that CodeGraph is unavailable — automatic indexing is switched off, the build failed, or the project is larger than the configured file ceiling — call \`codegraph_index\` with \`operation: init\`, which asks the user first.

Anti-patterns — do NOT:
- grep/glob first "to find the files": one \`codegraph_explore\` call replaces dozens of round-trips.
- re-verify codegraph results with grep: they come from a full AST parse.
- reconstruct a flow by hand: name the endpoints in one \`codegraph_explore\` and it surfaces the path between them.
- skip codegraph because the workspace looks unindexed: the index is built for you on the first call.
- keep calling codegraph after it reports the workspace is not indexed and the user declined to index it: use the built-in tools there instead.

Limits: the index is refreshed before every query, but a symbol added outside this session may still be missing until then. Cross-file resolution is best-effort name matching. CodeGraph is not a correctness check — that is still the compiler, tests, and linter.`
