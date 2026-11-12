# Tabby: the brief

Tabby is a one-page bill splitter. Build it in `public/` (plain HTML, CSS and JavaScript; no build step, no dependencies).

- A bill amount field.
- Tip choices: 10%, 15%, 20%.
- A number-of-people field.
- Show the total (bill plus tip) and what each person pays. The shares must add up to the total exactly; nobody can lose or gain a cent.
- If the number of people is 0 or empty, ask for at least one person instead of showing a broken amount.
- Remember the last bill, tip and number of people when the page is reloaded.
- Make it look good on a phone and on a laptop.

## Next: checkout extras

- **GST:** a switch that adds 5% GST to the bill. Off by default.
- **Coupons:** a coupon field. `WELCOME10` takes 10% off the bill. Any other code shows that the code is not valid and changes nothing.
- **Order of operations:** the coupon comes off the bill first. GST is charged on the discounted bill. The tip is a percentage of the discounted bill, before GST.
- **Round up:** a switch that rounds each person's share up to the next whole dollar. The extra goes to the tip, so the total grows to match.
- **Share link:** show a link that opens Tabby with exactly the same bill, tip, people, GST, coupon and round-up settings.
- Everything that already works must keep working.
