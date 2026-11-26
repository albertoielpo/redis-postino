# redis-postino monorepo

Redis pub/sub messaging for Node.js microservices: load-balanced at-most-once delivery, broadcast, dead letter queue and error queue, built on [node-redis](https://github.com/redis/node-redis).

| Package                                             | Path              | Description                                                           |
| --------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| [`redis-postino`](packages/core/README.md)          | `packages/core`   | Framework-agnostic core                                               |
| [`nestjs-redis-postino`](packages/nestjs/README.md) | `packages/nestjs` | NestJS 12 module (decorators, injectable channels), built on the core |

Requirements: Node.js >= 24.15, Redis >= 7.2 standalone, or Redis Cluster (**experimental**). The packages are ESM only.

Migrating from the previous ioredis-based library? See [MIGRATION.md](MIGRATION.md).

## Local development

The repository uses npm workspaces, Lerna and Nx (build/test cache).

```bash
npm i            # install and link the workspace packages
npm run build    # build both packages (core first)
npm test         # unit tests (vitest)
npm run lint     # eslint
npm run format   # prettier
```

### Testing local changes in another project

```bash
npm run build
cd ../my-project && npm i <path-to-this-repo>/packages/nestjs   # or packages/core
```

Later builds are picked up without reinstalling. Remember to switch back to the published version afterwards.

## Commit guidelines

Two Husky hooks run on commit:

1. `pre-commit` runs `npm run test`, `npm run format`, `npm run lint` and `git add --all`. The commit is blocked if any of them fails.
2. `commit-msg` validates the message on `main`, because the release pipeline reads it:

```
Action: [TASK-XXXX] Commit message
```

| Action   | Description                   | Release |
| -------- | ----------------------------- | ------- |
| Breaking | Backwards-incompatible change | Major   |
| New      | New feature                   | Minor   |
| Update   | Backwards-compatible change   | Minor   |
| Fix      | Bug fix                       | Patch   |
| Docs     | Documentation                 | None    |
| Build    | Build process                 | None    |
| Upgrade  | Dependency update             | None    |
| Chore    | Refactor, tests, etc.         | None    |

## Release

Releases run only on `main`. The CI `publish` job calls `./publish.sh "$CI_COMMIT_MESSAGE"`, which maps the action to a major/minor/patch `lerna publish` on **npmjs.com**.

- The CI variable `NPM_TOKEN` must hold an npm granular access token with publish rights on both packages.
- Both packages share one version (Lerna fixed mode), starting from `0.0.0`, so the first `Breaking:` release publishes `1.0.0`.
- For larger changes, branch from `main`, then open a merge request whose title follows the format above, and squash on merge.

## License

[MIT](LICENSE) © Alberto Ielpo, Davide Stefania
