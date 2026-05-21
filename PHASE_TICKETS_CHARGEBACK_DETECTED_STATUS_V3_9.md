# Tickets v3.9 — Chargeback detected status fix

Fixes the split between manual possible chargeback risk and explicit Shopify/backend chargeback detection.

- Manual ticket risk/title text remains orange possible-risk.
- Explicit `chargebackStatus` / `disputeStatus` values such as `detected` now count as a real chargeback signal.
- Confirmed/detected disputes show red card glow and the wording “Chargeback detected / تم رصد نزاع بنكي”.
- Risk text alone no longer creates a confirmed chargeback state.
