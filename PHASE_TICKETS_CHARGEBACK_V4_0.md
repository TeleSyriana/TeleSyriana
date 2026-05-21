PHASE TICKETS CHARGEBACK V4.0

Fix: separate manual chargeback risk from confirmed/detected Shopify chargebacks.

Behaviour:
- Manual risk only (Risk = chargeback / chargeback_risk / title contains possible chargeback wording):
  - Orange glow
  - Label: Possible chargeback risk / خطر نزاع بنكي محتمل
  - Does not pretend Shopify confirmed the chargeback.

- Confirmed/detected Shopify dispute:
  - Requires real backend dispute object or explicit chargebackStatus/disputeStatus.
  - Red glow
  - Label: Chargeback detected / تم رصد نزاع بنكي, or the real Shopify status:
    needs_response, under_review, won, lost, etc.

Important:
- Text/title alone is not enough to create confirmed red chargeback.
- Backend should return chargebackStatus/disputeStatus or disputes[] for confirmed cases.
