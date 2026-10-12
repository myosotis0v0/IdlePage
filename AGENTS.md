# Repository boundaries

- Production extension code belongs in src/. It must never import labs/.
- Experimental Qidian browser probes belong in labs/qidian/; they are not shipped with the extension.
- Tests for promoted production behavior belong in tests/. Browser feasibility probes are not production tests.
- docs/PLAN.md is the single shared design and progress record. Update evidence and pending items honestly after experiments.
- Never commit credentials, cookies, browser profiles, account details, bookshelf contents, chapter text, screenshots, or raw network traces.
- Account login and verification are performed manually on official pages. Do not automate purchases, subscription changes, or bypass access controls.
- Do not claim VIP extraction or session persistence works without authenticated live evidence.
