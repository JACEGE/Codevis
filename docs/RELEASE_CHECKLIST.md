# Release verification

Do not infer cross-platform readiness from a local Windows test run.

The `CI` workflow checks the same commit on Linux x64, Windows x64,
macOS Intel (`macos-15-intel`), and macOS Apple Silicon (`macos-15`),
each with Node 22.12.0 (the supported minimum) and Node 24.
Runner labels follow the [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Every combination must pass dependency installation, repository and dependency
audits, type checking, the test suite, the frontend build, and a fresh-package
installation test including database recovery and browser workspace isolation.
The final `Release platform gate` fails if a matrix job fails or is cancelled.
These tests do not call a paid model provider and do not publish a package.

Before publishing:

1. Push the intended release commit only with the maintainer's authorization.
2. Wait for all eight `CI / test` combinations and `Release platform gate` for
   that exact commit. The workflow also supports manual `workflow_dispatch`.
3. Investigate failures and skipped tests; do not waive native database,
   installation, recovery, or browser failures to obtain a green release.
4. Run `npm run release:check` in the publishing checkout. `prepublishOnly`
   already invokes this local gate; it does not inspect GitHub CI results.
5. Publish only after explicit approval.

The workflow alone does not configure branch protection or prevent a manual
`npm publish` from bypassing CI. Maintainers can require `Release platform gate`
in repository rules. Until actual CI results exist, Linux/macOS verification
remains pending, even when the workflow configuration validates locally.
