# SpliceTap Audit Reports

Independent review passes over the `V1` branch, each written by a reviewer with a
distinct lens. Every report follows the same structure so findings can be
compared and triaged together.

| Report | Lens |
|---|---|
| [security.md](security.md) | Threat model, injection, trust boundaries, data handling |
| [store-compliance.md](store-compliance.md) | MV3 correctness + Chrome Web Store review risk |
| [qa-edge-cases.md](qa-edge-cases.md) | Functional edge cases, race conditions, error paths |
| [performance.md](performance.md) | Hot paths, memory, storage/IPC cost, scale |
| [accessibility-ux.md](accessibility-ux.md) | a11y conformance and UX friction |
| [code-quality.md](code-quality.md) | Maintainability, duplication, coupling, testability |
| [product-gaps.md](product-gaps.md) | Competitive parity and product opportunity |

## Severity scale

| Level | Meaning |
|---|---|
| **Critical** | Breaks a core feature, or exposes user data / enables attack |
| **High** | Significant malfunction or risk; ship-blocking for a public release |
| **Medium** | Real defect with a workaround, or notable quality gap |
| **Low** | Minor defect, cosmetic, or narrow edge case |
| **Nit** | Style/consistency, no functional impact |

Findings are claims from static review unless explicitly marked as verified by
execution. Confidence is stated per finding.
