# DSH-MultipleConnect

The plugin targets DeepSeek Harness Web 0.2.1-rc.2. Keep the original channel adapters and use the shared ingress and reply paths. The Host owns the main conversation and tool sending policy. External message insertion, deduplication and notification enqueue belong in the same SQLite transaction.

- Build with `npm run build`.
- Run `node --test test/multiple-connect.test.mjs` for the shared routing and Snowluma regression tests.
- Run `node scripts/verify-package.mjs` to verify the package.
- Proactive code is based on dsh-proactive at commit `cae01f3`. Keep its license and use the DSH host’s runtime packages.
