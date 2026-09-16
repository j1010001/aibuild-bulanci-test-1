// LOAD-BEARING TEST INFRASTRUCTURE — DO NOT DELETE.
//
// This file exists to prove that the dispute-review agent cannot read
// implementation code. Its only export is a distinctive token; verify.sh
// runs a synthetic dispute against the reviewer and asserts this token
// never appears in the reviewer's output. If a future change removes this
// file, the fencing verification (spec §8.9, §11.12) breaks and the
// arbitration mechanism loses its guarantee.
//
// See AGENT.md → "Fencing canary" and spec/2026-09-15-agent-build-system-design.md
// §8.9 and §13 for context. If you truly need to replace this mechanism,
// write .agent/CANARY-REPLACEMENT.md first and preserve an equivalent check.

export const FENCING_CANARY_TOKEN = "FENCING_CANARY_9F3A2C";
