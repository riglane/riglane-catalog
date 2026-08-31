# Security policy — catalog

This repository holds **pointers**, not code: each entry names a workflow in its
author's repository at a pinned commit, plus a machine-generated inventory of
what that workflow can execute. Two different things can go wrong here, and they
have different reporting paths.

## Reporting a malicious or compromised entry

**Do not open a public issue.** Use private vulnerability reporting on this
repository (Security → Report a vulnerability).

A public issue naming an entry as malicious tells everyone reading it where to
find working malicious code, and does it before anything has been revoked.
Private first, revoked, then discussed.

Please include the entry id, the commit it is pinned to, and what the code
actually does. If you found it by reading the inventory on the entry page, saying
which line gave it away is genuinely useful.

**What happens next:** the id is added to `revoked.json`, and the CLI refuses to
install or update anything listed there from the moment the site rebuilds.
Already-installed copies are not removed remotely — we have no such power over
anyone's machine, and would not want it — but a community workflow only runs
where its user explicitly trusted it, and `riglane update` will refuse.

This is the one place where speed genuinely matters, so it takes priority over
everything else in the queue.

## Reporting a hole in the catalog's own guarantees

Also private, and also here. In scope:

- an entry whose installed tree does **not** match its published inventory —
  that is, a way to get past the regenerate-and-byte-compare check;
- a way to make CI **execute** submitted content rather than read it;
- a way to make the CI-derived level say **Verified** for a workflow that
  declares a shell surface;
- a way to make `riglane add` skip the revocation list, the pinned commit, or the
  inspection screen.

## Not a security issue

- **An entry being low quality, broken, or abandoned.** Open a normal issue.
- **An entry being *able* to run shell commands.** That is what the Community
  level means, it is printed verbatim before installation, and it is why nothing
  runs before `riglane trust`. Nobody has reviewed shared workflows for safety —
  the catalog says so everywhere rather than implying otherwise.
- **A workflow's prose steering an agent badly.** A shared workflow is also a
  shared prompt. Documented, not solved.

The engine's own security policy lives in the
[riglane repository](https://github.com/todor-rusev/riglane/blob/main/SECURITY.md).
