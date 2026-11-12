---
mode: testing
url: http://localhost:4310
tags: [tabby]
---

# Edge cases

## Nobody to split with
Type 80 into the bill amount field and set the number of people to 0.
Verify a message asks for at least one person, and that no "NaN" or "Infinity" appears anywhere on the page.

## It remembers the last bill
Type 64.50 into the bill amount field, choose the 20% tip and set the number of people to 2.
Reload the page.
Verify the bill amount is still 64.50 and the 20% tip is still selected.
