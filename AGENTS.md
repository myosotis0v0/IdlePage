# Repository boundaries

- Production extension code belongs in src/. It must never import labs/.
- Experimental Qidian browser probes belong in labs/qidian/; they are not shipped with the extension.
- Tests for promoted production behavior belong in tests/. Browser feasibility probes are not production tests.
- docs/PLAN.md is the single shared design and progress record. Update evidence and pending items honestly after experiments.
- Never commit credentials, cookies, browser profiles, account details, bookshelf contents, chapter text, screenshots, or raw network traces.
- Only login, re-login and verification within that login flow may require manual official-page interaction. After login, bookshelf pagination, catalog/chapter retrieval, session recovery and local progress persistence must be automatic. Never require manual browser navigation, extraction clicks or Cookie copying as the reading workflow.
- Runtime access challenges fail automation acceptance: stop and report AccessBlocked instead of adopting recurring manual CAPTCHA handling. Do not automate purchases, subscription changes or bypass access controls.
- Do not claim VIP extraction or session persistence works without authenticated live evidence.
