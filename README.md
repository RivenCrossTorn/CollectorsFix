# Collector's Fix · Ledger

Bookkeeping for the Collector's Fix bazaar in Torn: daily till, supplier lots and payouts, rent.

Site: https://rivencrosstorn.github.io/CollectorsFix/

## How it works
- Each person signs in with the account created for her in Supabase and pastes her own **Custom** Torn API key in Settings.
  The key stays in her browser and is only ever sent to `api.torn.com`. It is never stored in the database.
- **Sync now** reads that person's Torn logs (bazaar sales, item market sales, items received, muggings), her wallet,
  and what is still listed or in inventory, and saves the results to the shared database.
- A **lot** is every unit of one item from arrival until the last one sells. Items received from a registered supplier
  belong to him; everything else is Collector's Fix stock. When the lot sells out, revenue is split by units and the
  supplier's share minus your rate shows up in red on **Payouts** until it is marked paid.

## Files
- `index.html`, `app.js`: the site (static, no build step)
- `setup.sql`: run once in Supabase → SQL Editor to create the tables and access rules
