# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's [private vulnerability
reporting](https://github.com/BenSheridanEdwards/StyleProof/security/advisories/new)
rather than opening a public issue. Include a description, reproduction steps, and the
affected version.

You can expect an acknowledgement within a few working days and a fix or mitigation plan
once the report is confirmed. Please give a reasonable window to address the issue before
any public disclosure.

## Scope

StyleProof runs inside your own test/CI environment and reads pages you point
it at; it ships no server and makes no outbound network calls. The GitHub Action pushes a
report branch and posts PR comments using the token you provide. Reports of credential
handling, command injection, or path traversal in the CLIs, library, or Action are in
scope.

StyleProof imports and runs the `styleproof.config.*` it discovers. The limits of that
discovery are documented under [Configuration](README.md#configuration): group-writable
parent folders are trusted, and on Windows no owner or write check applies, so a `.git`
entry in a shared ancestor lets that ancestor's config load.
