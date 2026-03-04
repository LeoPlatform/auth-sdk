# Leo Auth SDK - Agent Context

## Overview

This repository is the **Leo Auth SDK** (npm package `leo-auth`). It provides a policy-based authorization system inspired by AWS IAM for the Leo Platform. The SDK controls access to resources using identity-based policies with support for conditions, wildcards, and context variables.

Key capabilities:
- **getUser(event)** – Look up user by Cognito Identity ID from LeoAuthUser DynamoDB table
- **authorize(event, resource)** – Check if user can perform action on resource (LRN)
- **bootstrap(config)** – Define policies in code for testing/development (bypasses DynamoDB)

Deny always overrides Allow. Policies are evaluated in two phases: Deny first, then Allow.

## Tech Stack

- **Language**: TypeScript + JavaScript (main `index.js` is JS; lib has TS)
- **Runtime**: Node.js
- **Testing**: Mocha, Chai, Sinon, nyc
- **Linting**: ESLint with @typescript-eslint
- **Config**: ConfigProviderChain, leo-config, env vars (LEOAUTH, LEOAUTH_*), Secrets Manager
- **AWS**: @aws-sdk/client-dynamodb, @aws-sdk/lib-dynamodb, @aws-sdk/client-s3, @aws-sdk/client-secrets-manager

## Project Structure

```
auth-sdk/
├── index.js             # Main entry (CommonJS)
├── lib/
│   ├── policy.js        # Policy validation logic
│   ├── chunker.js       # Batch/chunk utilities
│   ├── conditions.js    # Condition evaluation
│   └── provider-chain/  # Config resolution (TS)
│       ├── index.ts
│       ├── configuration.ts
│       ├── aws-util.ts
│       └── aws-sdk-sync.ts
├── test/                # Unit tests (*.utest.ts)
├── .eslintrc.json
├── tsconfig.json
└── package.json
```

## Development Setup

```bash
npm install
npm run compile          # Compile TypeScript
npm run watch            # Watch mode
npm run lint             # ESLint . --ext .ts
```

## Code Patterns

- **Configuration**: ConfigProviderChain resolves from LEOAUTH env, process.leoauth, config files, Secrets Manager, leo-config. Required: LeoAuth (policies table), LeoAuthUser (users table).
- **LRN (Leo Resource Name)**: Format `lrn:service:system:region:account:resource`. Used in policies and authorize().
- **Bootstrap mode**: `leoAuth.bootstrap({ actions, resource, identities, policies })` – in-memory policies; no DynamoDB. Use for tests.
- **User object**: Has `identity_id`, `identities`, `context`. `wrapUser()` adds `authorize(event, resource)` method.

## Testing

- **Test files**: `**/*.utest.ts` (compiled to `*.utest.js`)
- **Run tests**: `npm run test` or `npm run coverage-all`
- **Coverage**: `nyc --all`; test files use `*.utest.js` pattern
- **Bootstrap in tests**: Set `(process as any).leoauth = { LeoAuth, LeoAuthUser }` or use `bootstrap()` for in-memory policies

## Common Tasks

| Task | Command |
|------|---------|
| Compile | npm run compile |
| Lint | npm run lint |
| Run tests | npm run test |
| Full coverage | npm run coverage-all |
| Test all | npm run test-all |

## Gotchas

- **Main entry is JS**: `index.js` is JavaScript; lib/provider-chain is TypeScript. ESLint ignores `**/*.js` and `**/*.d.ts`.
- **Bootstrap vs DynamoDB**: Bootstrap overrides DynamoDB; cannot mix both in one request.
- **Context variables**: Use `${context.field}` in policies; variable substitution happens at evaluation time.
- **Condition field names**: Flattened with `:` separator (e.g. `context:account`). All lowercase in conditions.
- **Admin proxying**: When caller has `caller` (AWS key) but no cognitoIdentityId, check `_context.cognitoIdentityId` in body for impersonation.
