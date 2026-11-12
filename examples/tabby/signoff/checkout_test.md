---
mode: testing
url: http://localhost:4310
tags: [tabby]
---

# Tax, coupons, rounding and sharing

## GST
Type 100 into the bill amount field, choose the 15% tip and turn GST on.
Verify the total shows $120.00.

## A coupon
Enter the coupon code WELCOME10 and apply it.
Verify the total shows $108.00.

## A bad coupon
Enter the coupon code NOPE and apply it.
Verify a message says the code is not valid, and the total still shows $108.00.

## Round up
Set the number of people to 7 and turn on rounding up.
Verify each person pays $16.00 and the total shows $112.00.

## Share it
Find the share link on the page and open it.
Verify the opened page shows a bill of 100 with GST on, the WELCOME10 coupon applied, 7 people, rounding up on, and a total of $112.00.
