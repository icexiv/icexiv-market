# Development and CI

Use the `dev` branch for development and PR into `main`.

`deploy.yml` builds both international and domestic sites for pushes or PRs targeting `main`. PR jobs do not access TOS credentials or publish Shadow objects, and neither deployment job runs on a PR. Deployment requires a non-PR run on `main`; both sites deploy in parallel after checks succeed.

The scheduled item-data workflow explicitly checks out `main` and dispatches deployment on `main`. Item freshness checks use the job's GitHub token instead of the shared anonymous API quota. Shadow is pinned to a tested commit; its default inline metadata preserves media behavior.

Existing Market SSH authorization, deployment directory, filing information and uncommitted application changes are independent of the homepage/Eorzea deployment setup.
