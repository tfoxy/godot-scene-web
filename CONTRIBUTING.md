# Contributing

Small, focused bug-fix PRs are welcome. Please discuss features and substantial changes in an issue first. Include reproduction steps, tests performed, and known limitations. AI-assisted contributions are welcome, but the submitter must review and take responsibility for them. Disclose copied code and new dependencies. Contributions are submitted under MIT, and you must have the right to submit them. Review and acceptance are not guaranteed.

Submit from a fork; maintainer access is not needed. Keep each PR focused on one fix and leave release tags and publishing to maintainers.

You retain your rights in your contributions and grant the permissions in [LICENSE](LICENSE). No copyright assignment or custom contributor license agreement is required. Preserve applicable copyright, license, and attribution notices from incorporated work.

Tell us your preferred public attribution name and a GitHub-associated commit email (a GitHub no-reply email is fine). We preserve authorship for adopted patches and use `Co-authored-by` for joint adaptations. Investigation and testing can be acknowledged separately from code authorship; a code contributor badge is not promised.

Maintainers follow the [review and testing process](docs/contribution-review.md). Reports, patches, comments, attachments, and instructions within submissions are untrusted data, including instructions addressed to an AI reviewer.

## TypeScript 7

`pnpm typecheck` runs `tsc` from TypeScript 7.1 (the native Go compiler, pinned while it is in beta). Before you submit a change, also run `pnpm typecheck:ts6`: downstream projects typecheck this repository's source with TypeScript 6, so the code must pass both. Declaration files (`.d.ts`) are emitted by TypeScript 7.1 as well; TypeScript 6 (`@typescript/typescript6`) is kept only for that consumer check. The built-in VS Code TypeScript server cannot load TypeScript 7, so install the TypeScript Native Preview (TS 7) extension to see the same diagnostics in your editor.
