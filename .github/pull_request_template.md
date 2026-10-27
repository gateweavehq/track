## What and why

<!-- What does this change, and why is it needed? Link the issue it closes: "Closes #123". -->

## How it was tested

<!-- Commands you ran and what you checked by hand. Screenshots help for UI changes. -->

- [ ] `pnpm verify` passes
- [ ] Tests cover the change (every bug fix has a test that fails without it)

## Deploy notes

<!-- Delete what does not apply. -->

- [ ] Bumps `PROTOCOL_VERSION` (clients reload and re-sync)
- [ ] Adds a D1 migration (`pnpm --filter @tangent/web db:migrate:remote` on deploy)
- [ ] Adds a Durable Object migration (runs on its own when each workspace wakes)
- [ ] Adds an environment variable or secret (documented in `.dev.vars.example`)
