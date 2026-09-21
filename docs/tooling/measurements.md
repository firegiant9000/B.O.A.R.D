# Claude Code tooling rollout — measurements

Numbers only. No transcript excerpts, no query text, no identifiers. See the PHI rule in
`2026-09-17-claude-tooling-rollout-plan.md`.

| date | wave | repo | sysprompt | skilldesc | mcpinstr | totalinput | cacheread% | discoverycalls | discoverytokens |
|---|---|---|---|---|---|---|---|---|---|

<!--
PENDING — Task 1 Step 4 not yet run.

Procedure M requires `/session-report` in a FRESH session per repo, in this order:
B.O.A.R.D, PlanPal, WMSAPI, WMS_Reports, WMSSite. Wave label: M.

/session-report is still UNAVAILABLE as of 2026-09-21 session 2, and the reason is
not the session-start timing originally assumed here. Observed: the plugin is
enabled in ~/.claude/settings.json and installed_plugins.json records an install
at plugins/cache/claude-plugins-official/session-report/c447c3207a42 — but that
directory does not exist. The files were never copied out of the marketplace
checkout into the cache. Fix is interactive and Arlo's:
`/plugin install session-report@claude-plugins-official`.

Second, independent blocker: Procedure M step 1 is "open a session with the working
directory set to the repo", once per repo. An agent inside a session cannot do that.
Procedure M is Arlo-driven, not agent-executable.

Sanity check when the rows are taken: venture skill descriptions should account for
roughly 3,150 tokens of skilldesc in every repo (review §1). The spec's 5,800 figure
is wrong and must not be quoted.

Caveat for the WMS rows: Wave 2 config is frozen in unmerged PRs, so WMSAPI /
WMS_Reports / WMSSite baselines are valid as baselines but their post-wave
comparisons will not move until those PRs merge or the branches are checked out.
-->
