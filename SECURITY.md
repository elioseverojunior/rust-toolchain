<!--
SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors

SPDX-License-Identifier: MIT OR Apache-2.0
-->

# Security Policy

## Supported Versions

This repository publishes a **GitHub Action**, not a crate — there is no
package on crates.io and none on npm. What you pin is a git tag, so what is
"supported" is a reference rather than a version number.

| Reference          | Example         | Receives security fixes                        |
| ------------------ | --------------- | ---------------------------------------------- |
| Moving major float | `@v0`           | Yes — retargeted to the newest release         |
| Moving minor float | `@v0.5`         | Yes — retargeted to the newest `0.5.x` release |
| Exact release      | `@v0.5.0-11`    | Only while it is the newest release            |
| Commit SHA         | `@<commit-sha>` | Only while it is the newest release's commit   |
| Default branch     | `@main`         | No — unreleased, and not a supported reference |

Only the newest release is patched; there are no backports to an earlier tag.
Because the major and minor floats are retargeted on every release, a workflow
pinned to one picks the fix up on its next run with no change. A workflow pinned
to an exact release or a commit SHA — which the OpenSSF Scorecard and many
supply-chain policies ask for — has to be bumped by hand, which is the cost that
buys the reproducibility. See [Versioning](README.md#versioning) for the full
table of what each reference points at.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities through GitHub private security advisories:

<https://github.com/elioseverojunior/rust-toolchain/security/advisories/new>

You will receive an acknowledgement within **2 business days** and a
status update (accepted, declined, or in progress) within **7 calendar
days**. If a fix is warranted the maintainers will coordinate a release
under an embargo and credit the reporter in the advisory unless
anonymity is requested.
